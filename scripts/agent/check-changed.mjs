#!/usr/bin/env bun
/**
 * Runs the tests, lint, and typecheck that the current changes can affect, so an agent checks its changed scope with
 * one command instead of choosing test folders by hand. CI still owns the full suites.
 *
 * Usage: bun run check:changed [--since <ref>]
 *
 * Without --since it checks staged, unstaged, and untracked files, the same set `vitest --changed` reads. With
 * --since it adds every file committed on this branch since its merge base with <ref>.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const LINTABLE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// Edits to these change how every workspace builds or checks, so a scoped run cannot vouch for them.
const SHARED_CONFIG_FILES = new Set([".oxlintrc.json", "bun.lock", "package.json", "tsconfig.base.json", "turbo.json"]);
const AGENT_SCRIPTS_DIR = "scripts/agent/";
// Windows rejects command lines past 32,767 characters; past this many, lint runs over the whole repository.
const MAX_LINT_ARGUMENT_CHARS = 24_000;
const OXLINT_PLUGIN_DIR = "packages/oxlint-plugin";

/** Reads `--since <ref>`; any other argument is a mistake worth stopping on. */
export function parseCheckArgs(argv) {
  if (argv.length === 0) return { since: null };
  if (argv[0] === "--since" && argv[1] && !argv[1].startsWith("-") && argv.length === 2) return { since: argv[1] };
  throw new Error(`Usage: bun run check:changed [--since <ref>] (got: ${argv.join(" ")})`);
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

function testJob(workspace, since) {
  // Vitest maps the changed files to the tests that import them, so each workspace keeps its own test script.
  const changed = since ? `--changed=${since}` : "--changed";
  return {
    label: `test ${workspace.dir}`,
    cwd: workspace.dir,
    args: ["run", "test", "--", changed, "--passWithNoTests", "--reporter=dot", "--silent=passed-only"],
  };
}

function lintJob(lintFiles) {
  const scoped = lintFiles.join(" ").length <= MAX_LINT_ARGUMENT_CHARS;
  return {
    label: scoped ? `lint ${lintFiles.length} file${lintFiles.length === 1 ? "" : "s"}` : "lint (whole repository)",
    cwd: ".",
    args: ["x", "oxlint", ...(scoped ? lintFiles : [])],
  };
}

/** Agent script tests to run: changed test files, and the test named after each changed script. */
export function agentTestFiles(files, exists) {
  const tests = new Set();
  for (const file of files) {
    if (!file.startsWith(AGENT_SCRIPTS_DIR) || !file.endsWith(".mjs")) continue;
    tests.add(file.endsWith(".test.mjs") ? file : `${AGENT_SCRIPTS_DIR}__tests__/${NodePath.basename(file, ".mjs")}.test.mjs`);
  }
  return [...tests].filter(exists).sort();
}

/**
 * The checks the changed files call for. `exists` reports whether a repository-relative path is on disk, so deleted
 * files still select their workspace but never reach the linter.
 */
export function planChecks({ files, workspaces, since, exists }) {
  const touched = new Set(files.map((file) => workspaceOf(file, workspaces)?.name).filter(Boolean));
  const affected = affectedWorkspaces(touched, workspaces);
  const jobs = [
    ...affected.filter((workspace) => workspace.scripts.test).map((workspace) => testJob(workspace, since)),
    ...affected
      .filter((workspace) => workspace.scripts.typecheck)
      .map((workspace) => ({ label: `typecheck ${workspace.dir}`, cwd: workspace.dir, args: ["run", "typecheck"] })),
  ];
  const lintFiles = files.filter((file) => LINTABLE_FILE.test(file) && exists(file));
  if (lintFiles.length > 0) jobs.push(lintJob(lintFiles));
  const agentTests = agentTestFiles(files, exists);
  if (agentTests.length > 0) {
    jobs.push({ label: `agent script tests (${agentTests.length})`, cwd: ".", args: ["scripts/agent/test-scripts.mjs", ...agentTests] });
  }
  const sharedConfig = files.filter((file) => SHARED_CONFIG_FILES.has(file) || file.startsWith(`${OXLINT_PLUGIN_DIR}/`));
  const notes = sharedConfig.length > 0
    ? [
        `Shared config changed (${sharedConfig.join(", ")}): scoped checks cannot vouch for it. Run bun run lint and bun run typecheck too.`
          + " A changed package.json also makes Vitest run each affected workspace's whole suite.",
      ]
    : [];
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
  const { since } = parseCheckArgs(process.argv.slice(2));
  const files = gitChangedFiles(root, since);
  if (files.length === 0) {
    console.log("No changed files.");
    return;
  }
  const exists = (file) => NodeFS.existsSync(NodePath.join(root, file));
  const { jobs, notes } = planChecks({ files, workspaces: readWorkspaces(root), since, exists });
  console.log(`${files.length} changed file${files.length === 1 ? "" : "s"}; running: ${jobs.map((job) => job.label).join(", ")}`);
  if (jobs.some((job) => job.label.startsWith("lint"))) ensureLintPluginBuilt(root);
  const results = await Promise.all(jobs.map(async (job) => {
    const result = await runJob(root, job);
    console.log(summarize(result));
    return result;
  }));
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
