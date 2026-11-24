#!/usr/bin/env bun
/**
 * Runs tests tied to changed files by name or import. When neither matches, tries tests named after a direct importer.
 * Lints changed files and typechecks affected workspaces, including dependents. CI still owns the full suites.
 *
 * Usage: bun run check:changed [--since <ref>] [--full]
 *
 * Without --since it checks staged, unstaged, and untracked files. With --since it adds the branch changes since
 * the merge base with <ref>. With --full it uses Vitest's --changed selection in all affected workspaces.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const LINTABLE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts|js|mjs)$/;
// Match literal specifiers and skip comments and strings outside an import, re-export, or mock.
const IMPORT_PREFIXES = [
  /\bimport\b\s*(?:(?:[\w$*,\s]*\{[^}]*\}|[\w$*,\s]+)\s*from\s*)?/,
  /\bexport\b\s*(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*/,
  /\b(?:import|vi\.mock)\s*\(\s*/,
];
const IMPORT_SPECIFIER = new RegExp([
  `(?:${IMPORT_PREFIXES.map((prefix) => prefix.source).join("|")})${/(["'])([^"'\r\n]+)\1/.source}`,
  /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//.source,
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/.source,
].join("|"), "g");
// Edits to these change how every workspace builds or checks, so a scoped run cannot vouch for them.
const SHARED_CONFIG_FILES = new Set([".oxlintrc.json", "bun.lock", "package.json", "tsconfig.base.json", "turbo.json"]);
const AGENT_SCRIPTS_DIR = "scripts/agent/";
const ELECTRON_HARNESS_SCRIPTS_DIR = ".agents/skills/electorn-live-testing/scripts";
// Leave room for the executable and flags under the Windows command-line limit.
const MAX_LINT_ARGUMENT_CHARS = 24_000;
const OXLINT_PLUGIN_DIR = "packages/oxlint-plugin";
const VITEST_FLAGS = ["--passWithNoTests", "--reporter=dot", "--silent=passed-only"];

/** Reads `--since <ref>` and `--full` in either order. */
export function parseCheckArgs(argv) {
  let since = null;
  let full = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--since" && since === null && next && !next.startsWith("-")) {
      since = next;
      index += 1;
    } else if (arg === "--full" && !full) {
      full = true;
    } else {
      throw new Error(`Usage: bun run check:changed [--since <ref>] [--full] (got: ${argv.join(" ")})`);
    }
  }
  return { since, full };
}

function gitLines(root, args) {
  const output = NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Changed repository-relative paths, including deleted ones, which can still break a dependent's types. */
export function gitChangedFiles(root, since) {
  const committed = since ? gitLines(root, ["diff", "--name-only", `${since}...HEAD`]) : [];
  const staged = gitLines(root, ["diff", "--cached", "--name-only"]);
  const unstaged = gitLines(root, ["ls-files", "--other", "--modified", "--exclude-standard"]);
  return [...new Set([...committed, ...staged, ...unstaged])].sort();
}

function workspaceDirectories(root, patterns) {
  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return NodeFS.readdirSync(NodePath.join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
}

/** Every workspace with its package name, scripts, and the workspace packages it depends on. */
export function readWorkspaces(root) {
  const rootManifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  return workspaceDirectories(root, rootManifest.workspaces ?? [])
    .filter((dir) => NodeFS.existsSync(NodePath.join(root, dir, "package.json")))
    .map((dir) => {
      const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, dir, "package.json"), "utf8"));
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      return { dir, name: manifest.name, scripts: manifest.scripts ?? {}, dependsOn: Object.keys(dependencies) };
    });
}

/** The workspace that owns `file`, or null for files outside every workspace. */
export function workspaceOf(file, workspaces) {
  return workspaces.find((workspace) => file.startsWith(`${workspace.dir}/`)) ?? null;
}

/** The touched workspaces plus every workspace that depends on one of them, directly or transitively. */
export function affectedWorkspaces(touchedNames, workspaces) {
  const affected = new Set(touchedNames);
  let grew = true;
  while (grew) {
    grew = false;
    for (const workspace of workspaces) {
      if (affected.has(workspace.name)) continue;
      if (!workspace.dependsOn.some((name) => affected.has(name))) continue;
      affected.add(workspace.name);
      grew = true;
    }
  }
  return workspaces.filter((workspace) => affected.has(workspace.name));
}

/** Matches test scripts that receive file paths appended to the Vitest CLI. */
export const TAKES_FILE_ARGUMENTS = /\bvitest(?:\.mjs)?\s+run\s*$/;

function fullTestJob(dir, since) {
  const changed = since ? `--changed=${since}` : "--changed";
  return {
    label: `test ${dir}`,
    cwd: dir,
    args: ["run", "test", "--", changed, ...VITEST_FLAGS],
  };
}

function listWorkspaceFiles(root, dir) {
  const output = NodeChildProcess.execFileSync(
    "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\0").filter(Boolean))];
}

function stem(file) {
  return NodePath.basename(file, NodePath.extname(file));
}

function namedTests(tests, sourceStem) {
  return tests.filter((test) => {
    const testStem = NodePath.basename(test).replace(TEST_FILE, "");
    return testStem === sourceStem || testStem.startsWith(`${sourceStem}-`);
  });
}

function withoutExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

/**
 * The repository-relative module path a specifier names, without extension, or null when it points outside the
 * workspace. Resolving the path instead of comparing basenames keeps a change to one `types.ts` from selecting every
 * test that imports some other `types` module. `@/` mirrors the `@/*` -> `./src/*` alias in apps/web/tsconfig.json.
 */
function resolveSpecifier(importer, specifier, dir) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return withoutExtension(NodePath.posix.join(NodePath.posix.dirname(importer), specifier));
  }
  if (specifier.startsWith("@/")) return withoutExtension(`${dir}/src/${specifier.slice(2)}`);
  return null;
}

/** Maps each source to the files that import it; a source named `index` is also reached through its folder. */
function filesByImport(files, sources, dir, readFile) {
  const sourceByModule = new Map();
  for (const source of sources) {
    const module = withoutExtension(source);
    sourceByModule.set(module, source);
    if (NodePath.posix.basename(module) === "index") sourceByModule.set(NodePath.posix.dirname(module), source);
  }
  const matches = new Map();
  for (const file of files) {
    for (const [, , specifier] of readFile(file).matchAll(IMPORT_SPECIFIER)) {
      if (!specifier) continue;
      const source = sourceByModule.get(resolveSpecifier(file, specifier, dir));
      if (!source) continue;
      if (!matches.has(source)) matches.set(source, new Set());
      matches.get(source).add(file);
    }
  }
  return matches;
}

function selectDirectTests({ files, dir, exists, listFiles, readFile, notes }) {
  const selected = files.filter((file) => TEST_FILE.test(file) && exists(file));
  const sources = files.filter((file) => LINTABLE_FILE.test(file) && !TEST_FILE.test(file));
  if (sources.length === 0) return selected.sort();

  const index = listFiles(dir).filter((file) => LINTABLE_FILE.test(file) && exists(file));
  const tests = index.filter((file) => TEST_FILE.test(file));
  const testImports = filesByImport(tests, sources, dir, readFile);
  const unmatched = [];
  for (const source of sources) {
    const directTests = [...namedTests(tests, stem(source)), ...(testImports.get(source) ?? [])];
    if (directTests.length === 0) unmatched.push(source);
    selected.push(...directTests);
  }

  if (unmatched.length > 0) {
    const importers = filesByImport(index.filter((file) => !TEST_FILE.test(file)), unmatched, dir, readFile);
    for (const source of unmatched) {
      const indirectTests = [...(importers.get(source) ?? [])]
        .flatMap((importer) => namedTests(tests, stem(importer)));
      if (indirectTests.length === 0) notes.push(`no direct tests for ${source}`);
      selected.push(...indirectTests);
    }
  }
  return [...new Set(selected)].sort();
}

function directTestJobs(dir, tests) {
  const jobs = [];
  let paths = [];
  let chars = 0;
  function addJob() {
    jobs.push({
      label: `test ${dir} (${paths.length} ${paths.length === 1 ? "file" : "files"})`,
      cwd: dir,
      args: ["run", "test", "--", ...VITEST_FLAGS, ...paths],
    });
  }
  for (const test of tests) {
    const path = test.slice(dir.length + 1);
    if (paths.length > 0 && chars + 1 + path.length > MAX_LINT_ARGUMENT_CHARS) {
      addJob();
      paths = [];
      chars = 0;
    }
    chars += paths.length > 0 ? 1 + path.length : path.length;
    paths.push(path);
  }
  if (paths.length > 0) addJob();
  return jobs;
}

function lintJob(lintFiles) {
  const scoped = lintFiles.join(" ").length <= MAX_LINT_ARGUMENT_CHARS;
  return {
    label: scoped ? `lint ${lintFiles.length} file${lintFiles.length === 1 ? "" : "s"}` : "lint (whole repository)",
    cwd: ".",
    args: ["x", "oxlint", ...(scoped ? lintFiles : [])],
  };
}

/** Selects matching agent script tests and the full suite for any Electron harness change. */
export function agentTestFiles(files, exists, listFiles = (dir) => listWorkspaceFiles(process.cwd(), dir)) {
  const tests = new Set();
  for (const file of files) {
    if (!file.endsWith(".mjs")) continue;
    const testName = `${NodePath.basename(file, ".mjs")}.test.mjs`;
    if (file.startsWith(AGENT_SCRIPTS_DIR)) {
      tests.add(file.endsWith(".test.mjs") ? file : `${AGENT_SCRIPTS_DIR}__tests__/${testName}`);
    }
  }
  if (files.some((file) => NodePath.posix.dirname(file) === ELECTRON_HARNESS_SCRIPTS_DIR)) {
    for (const file of listFiles(ELECTRON_HARNESS_SCRIPTS_DIR)) {
      if (NodePath.posix.dirname(file) === ELECTRON_HARNESS_SCRIPTS_DIR && file.endsWith(".test.mjs")) {
        tests.add(file);
      }
    }
  }
  return [...tests].filter(exists).sort();
}

/**
 * The checks the changed files call for. `exists` reports whether a repository-relative path is on disk, so deleted
 * files still select their workspace but never reach the linter. `listFiles` and `readFile` use repository-relative paths.
 */
export function planChecks({
  root, files, workspaces, since, full = false, exists,
  listFiles = (dir) => listWorkspaceFiles(root, dir),
  readFile = (file) => NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
}) {
  const touched = new Map();
  for (const file of files) {
    const workspace = workspaceOf(file, workspaces);
    if (!workspace) continue;
    if (!touched.has(workspace.name)) touched.set(workspace.name, []);
    touched.get(workspace.name).push(file);
  }
  const affected = affectedWorkspaces(touched.keys(), workspaces);
  const notes = [];
  const jobs = [
    ...affected
      .filter((workspace) => workspace.scripts.test)
      .flatMap(({ dir, name, scripts }) => {
        if (full) return [fullTestJob(dir, since)];
        if (!touched.has(name) || !TAKES_FILE_ARGUMENTS.test(scripts.test)) return [];
        const tests = selectDirectTests({ files: touched.get(name), dir, exists, listFiles, readFile, notes });
        return directTestJobs(dir, tests);
      }),
    ...affected
      .filter((workspace) => workspace.scripts.typecheck)
      .map((workspace) => ({ label: `typecheck ${workspace.dir}`, cwd: workspace.dir, args: ["run", "typecheck"] })),
  ];
  const lintFiles = files.filter((file) => LINTABLE_FILE.test(file) && exists(file));
  if (lintFiles.length > 0) jobs.push(lintJob(lintFiles));
  const agentTests = agentTestFiles(files, exists, listFiles);
  if (agentTests.length > 0) {
    jobs.push({ label: `agent script tests (${agentTests.length})`, cwd: ".", args: ["scripts/agent/test-scripts.mjs", ...agentTests] });
  }
  const sharedConfig = files.filter((file) => SHARED_CONFIG_FILES.has(file) || file.startsWith(`${OXLINT_PLUGIN_DIR}/`));
  if (sharedConfig.length > 0) {
    notes.push(`Shared config changed (${sharedConfig.join(", ")}): scoped checks cannot vouch for it. Run bun run lint, bun run typecheck, and bun run check:changed --full too.`);
  }
  return { jobs, notes };
}

function newestModifiedTime(dir) {
  let newest = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    newest = Math.max(newest, NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

/** The lint rules load from the plugin's built bundle, so rebuild it only when its source is newer. */
function ensureLintPluginBuilt(root) {
  const bundle = NodePath.join(root, OXLINT_PLUGIN_DIR, "dist", "index.mjs");
  const source = NodePath.join(root, OXLINT_PLUGIN_DIR, "src");
  if (NodeFS.existsSync(bundle) && NodeFS.statSync(bundle).mtimeMs >= newestModifiedTime(source)) return;
  NodeChildProcess.execFileSync(process.execPath, ["run", "--cwd", OXLINT_PLUGIN_DIR, "build"], { cwd: root, stdio: "inherit" });
}

function runJob(root, job) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, job.args, { cwd: NodePath.join(root, job.cwd) });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ job, code: 1, output: String(error), seconds: 0 }));
    child.on("close", (code) => resolve({ job, code: code ?? 1, output, seconds: (Date.now() - started) / 1000 }));
  });
}

/** One line for a finished check: its outcome, and for tests the summary or that no test imports the change. */
export function summarize({ job, code, output, seconds }) {
  const status = code === 0 ? "PASS" : "FAIL";
  const testSummary = output.match(/^\s*Tests\s+(.+)$/m)?.[1]?.trim();
  const detail = /No test files found/.test(output) ? "no affected tests" : (testSummary ?? "");
  return `${status}  ${job.label}  (${seconds.toFixed(1)}s)${detail ? `  ${detail}` : ""}`;
}

async function main() {
  const root = NodePath.resolve(gitLines(process.cwd(), ["rev-parse", "--show-toplevel"])[0]);
  const { since, full } = parseCheckArgs(process.argv.slice(2));
  const files = gitChangedFiles(root, since);
  if (files.length === 0) {
    console.log("No changed files.");
    return;
  }
  const exists = (file) => NodeFS.existsSync(NodePath.join(root, file));
  const { jobs, notes } = planChecks({ root, files, workspaces: readWorkspaces(root), since, full, exists });
  console.log(`${files.length} changed file${files.length === 1 ? "" : "s"}; running: ${jobs.map((job) => job.label).join(", ")}`);
  if (jobs.some((job) => job.label.startsWith("lint"))) ensureLintPluginBuilt(root);
  async function runAndSummarize(job) {
    const result = await runJob(root, job);
    console.log(summarize(result));
    return result;
  }
  const isTest = (job) => job.label.startsWith("test ");
  const results = await Promise.all(jobs.filter((job) => !isTest(job)).map(runAndSummarize));
  for (const job of jobs.filter(isTest)) {
    results.push(await runAndSummarize(job));
  }
  for (const failed of results.filter((result) => result.code !== 0)) {
    console.log(`\n---- ${failed.job.label} ----\n${failed.output.trimEnd()}`);
  }
  for (const note of notes) console.log(`\nNOTE  ${note}`);
  process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  await main();
}
