import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { collectRunEnvironment } from "./frontend-performance-collectors.mjs";

const USAGE = "Usage: bun run bench -- <workspace> [vitest args] [--baseline <report.json>]";

/** Lists host and runtime fields that make two benchmark environments incomparable. */
export function findEnvironmentMismatches(baselineEnvironment, currentEnvironment) {
  const mismatches = [];
  for (const section of ["host", "versions"]) {
    const baseline = baselineEnvironment?.[section] ?? {};
    const current = currentEnvironment?.[section] ?? {};
    const fields = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    for (const field of fields) {
      if (baseline[field] !== current[field]) {
        mismatches.push({ field: `${section}.${field}`, baseline: baseline[field], current: current[field] });
      }
    }
  }
  return mismatches;
}

function parseArguments(args) {
  const argumentsWithoutSeparators = args.filter((argument) => argument !== "--");
  const forwarded = [];
  let workspace;
  let baselineFile;
  for (let index = 0; index < argumentsWithoutSeparators.length; index += 1) {
    const argument = argumentsWithoutSeparators[index];
    if (/^--(?:outputJson|compare)(?:=|$)/.test(argument)) {
      throw new Error("The runner sets --outputJson and --compare; use --baseline instead.");
    }
    if (argument === "--baseline") {
      const value = argumentsWithoutSeparators[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`--baseline requires a report file.\n${USAGE}`);
      }
      baselineFile = value;
      index += 1;
    } else if (workspace === undefined && !argument.startsWith("-")) {
      workspace = argument;
    } else {
      forwarded.push(argument);
    }
  }
  if (!workspace) throw new Error(`A workspace is required.\n${USAGE}`);
  return { workspace, baselineFile, forwarded };
}

function isInsideRepo(repoRoot, directory) {
  const relative = NodePath.relative(repoRoot, directory);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${NodePath.sep}`)
    && !NodePath.isAbsolute(relative);
}

function resolveWorkspace(repoRoot, workspace) {
  const directory = NodePath.resolve(repoRoot, workspace);
  const invalidWorkspace = `Workspace "${workspace}" must be inside the repo and have a package.json with a bench script.`;
  if (!isInsideRepo(repoRoot, directory) || !NodeFS.existsSync(directory)) {
    throw new Error(invalidWorkspace);
  }
  const realDirectory = NodeFS.realpathSync(directory);
  const packageFile = NodePath.join(realDirectory, "package.json");
  if (!isInsideRepo(repoRoot, realDirectory) || !NodeFS.existsSync(packageFile)) {
    throw new Error(invalidWorkspace);
  }
  const manifest = JSON.parse(NodeFS.readFileSync(packageFile, "utf8"));
  if (typeof manifest.scripts?.bench !== "string" || manifest.scripts.bench.trim() === "") {
    throw new Error(invalidWorkspace);
  }
  return realDirectory;
}

function readBaseline(baselineFile, environment) {
  const baseline = JSON.parse(NodeFS.readFileSync(baselineFile, "utf8"));
  const mismatches = findEnvironmentMismatches(baseline.environment, environment);
  if (mismatches.length === 0) return baseline;
  for (const mismatch of mismatches) {
    process.stderr.write(`${mismatch.field}: baseline=${JSON.stringify(mismatch.baseline)}, current=${JSON.stringify(mismatch.current)}\n`);
  }
  throw new Error("Record a new baseline on this machine before comparing benchmarks.");
}

function runBench() {
  const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
  const { workspace, baselineFile, forwarded } = parseArguments(process.argv.slice(2));
  const directory = resolveWorkspace(repoRoot, workspace);
  const nodeVersion = NodeChildProcess.execFileSync("node", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim().replace(/^v/, "");
  const environment = collectRunEnvironment(repoRoot, { node: nodeVersion, bun: process.versions.bun });
  const baseline = baselineFile ? readBaseline(NodePath.resolve(repoRoot, baselineFile), environment) : null;
  const outputRoot = NodePath.resolve(repoRoot, ".dev", "verification", "performance");
  NodeFS.mkdirSync(outputRoot, { recursive: true });
  const temporaryId = NodeCrypto.randomUUID();
  const outputFile = NodePath.join(outputRoot, `.bench-${temporaryId}.json`);
  const comparisonFile = NodePath.join(outputRoot, `.bench-baseline-${temporaryId}.json`);
  try {
    const args = ["run", "bench", "--outputJson", outputFile];
    if (baseline) {
      NodeFS.writeFileSync(comparisonFile, JSON.stringify(baseline.vitest));
      args.push("--compare", comparisonFile);
    }
    args.push(...forwarded);
    const result = NodeChildProcess.spawnSync(process.execPath, args, {
      cwd: directory,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
    const vitest = JSON.parse(NodeFS.readFileSync(outputFile, "utf8"));
    const workspaceName = NodePath.relative(repoRoot, directory).split(NodePath.sep).join("/");
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const reportFile = NodePath.join(outputRoot, `bench-${workspaceName.replaceAll("/", "-")}-${timestamp}.json`);
    NodeFS.writeFileSync(reportFile, `${JSON.stringify({ workspace: workspaceName, arguments: forwarded, environment, vitest }, null, 2)}\n`);
    process.stdout.write(`Benchmark report: ${reportFile}\n`);
    return 0;
  } finally {
    NodeFS.rmSync(outputFile, { force: true });
    NodeFS.rmSync(comparisonFile, { force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = runBench();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
