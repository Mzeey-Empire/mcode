#!/usr/bin/env bun
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { findPackagedDesktop } from "../../apps/desktop/scripts/desktop-packaging/package-validation/desktop-reliability-test.mjs";
import { resolveSourceDbPath } from "../db-seed.mjs";
import { buildFixture, databaseStats } from "./app-startup/fixture.mjs";
import { assertPackagedExecutable, cleanupStaleRoots, launchOnce, launchPlan, readLogs, removeTree } from "./app-startup/runtime.mjs";
import { summarizeRecords } from "./app-startup/analysis.mjs";
import { buildReceipt } from "./app-startup/receipt.mjs";

const repo = NodePath.resolve(import.meta.dirname, "../..");
const help = `Usage: bun run perf:startup [--exe <path>] [--baseline <exe>] [--source <db>] [--variants A,B] [--launches 10] [--name <name>]
       bun run perf:startup:records --logs <dir> [--days 7]
Runs on Windows. Each variant and build gets one discarded warm-up, then interleaved measured launches.
Receipts: .dev/verification/performance/app-startup/<name>/
--help  Show this help without reading data or launching processes.`;

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function runOptions(options) {
  const launches = positiveInteger(options.launches ?? "10", "launches");
  const variants = (options.variants ?? "A,B").split(",");
  if (new Set(variants).size !== variants.length || variants.some((v) => !["A", "B"].includes(v))) {
    throw new Error("variants must be A, B or A,B");
  }
  const name = options.name ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error("Receipt name must contain only letters, digits, underscores and hyphens");
  return { launches, variants, name, builds: packagedBuilds(options) };
}

function packagedBuilds(options) {
  const exe = options.exe ? NodePath.resolve(options.exe) : findPackagedDesktop()?.desktop;
  if (!exe) throw new Error("Packaged Desktop executable not found");
  assertPackagedExecutable(exe, "--exe");
  const builds = { candidate: exe };
  if (options.baseline) {
    const baseline = NodePath.resolve(options.baseline);
    assertPackagedExecutable(baseline, "--baseline");
    return { baseline, ...builds };
  }
  return builds;
}

async function run(options) {
  const { launches, variants, name, builds } = runOptions(options);
  // Stale-root cleanup needs Windows to block renaming a directory while a process holds a file inside it.
  if (process.platform !== "win32") throw new Error("perf:startup launches run on Windows only");
  const parent = NodePath.join(NodeOS.tmpdir(), "mcode-perf-startup");
  cleanupStaleRoots(parent);
  const root = NodePath.join(parent, `run-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(root);
  NodeFS.writeFileSync(NodePath.join(root, "harness.pid"), String(process.pid));
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Startup harness interrupted"));
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let cleanupFailed = false;
  try {
    const source = resolveSourceDbPath(options.source);
    const { fixtures, stats } = prepareFixtures(source, root, variants);
    const plan = launchPlan(variants, Object.keys(builds), launches);
    const keyFor = (variant, build) => options.baseline ? `${variant} ${build}` : variant;
    const results = Object.fromEntries(plan.map(({ variant, build }) => [keyFor(variant, build), []]));
    const warmupFailed = [];
    for (const { index, variant, build } of plan) {
      controller.signal.throwIfAborted();
      const result = await launchOnce({
        exe: builds[build],
        fixture: fixtures[variant],
        root: NodePath.join(root, `${variant}-${build}-${index}`),
        signal: controller.signal,
      });
      const key = keyFor(variant, build);
      if (index > 0) results[key].push(result);
      else if (result.failed) warmupFailed.push(key);
    }
    writeReceipt(results, stats, name, warmupFailed);
  } catch (error) {
    cleanupFailed = error.cleanupFailed === true;
    throw error;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    if (cleanupFailed) {
      console.error(`Kept harness root ${root}; the next run deletes it once no process holds it`);
      process.exitCode = 1;
    } else {
      await removeTree(root).catch((error) => {
        console.error(`Delete the harness root by hand, it holds fixture data: ${root}
${error.message}`);
        process.exitCode = 1;
      });
    }
  }
}

function prepareFixtures(source, root, variants) {
  const fixtureA = NodePath.join(root, "A.db");
  buildFixture(source, fixtureA, root, NodePath.join(repo, ".dev/fixture-repo"));
  const fixtures = { A: fixtureA };
  const stats = { donor: databaseStats(source), A: databaseStats(fixtureA) };
  if (variants.includes("B")) {
    fixtures.B = NodePath.join(root, "B.db");
    NodeFS.copyFileSync(fixtureA, fixtures.B);
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(repo, "apps/server/scripts/prepare-startup-cutoff-turn.ts"), fixtures.B],
      { cwd: repo, stdio: "pipe", env: { ...process.env, MCODE_DATA_DIR: root } },
    );
    if (child.error || child.status !== 0) throw new Error("Cut-off fixture preparation failed");
    stats.B = databaseStats(fixtures.B);
  }
  return { fixtures, stats };
}

function writeReceipt(results, stats, name, warmupFailed) {
  const { receipt, markdown } = buildReceipt(results, stats, warmupFailed);
  const output = NodePath.join(repo, ".dev/verification/performance/app-startup", name);
  NodeFS.mkdirSync(output, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  NodeFS.writeFileSync(NodePath.join(output, "summary.md"), markdown);
  console.log(markdown);
  if (warmupFailed.length || Object.values(results).flat().some((row) => row.failed)) process.exitCode = 1;
}

function summarizeLogs(options) {
  if (!options.logs) throw new Error("--logs is required");
  const parsed = readLogs(NodePath.resolve(options.logs));
  const summary = summarizeRecords(parsed.records, positiveInteger(options.days ?? "7", "days"));
  console.log(JSON.stringify({ ...summary, invalidRecords: parsed.invalid }, null, 2));
}

try {
  const { values } = NodeUtil.parseArgs({
    options: {
      help: { type: "boolean" },
      records: { type: "boolean" },
      exe: { type: "string" },
      baseline: { type: "string" },
      source: { type: "string" },
      variants: { type: "string" },
      launches: { type: "string" },
      name: { type: "string" },
      logs: { type: "string" },
      days: { type: "string" },
    },
  });
  if (values.help) console.log(help);
  else if (values.records) summarizeLogs(values);
  else await run(values);
} catch (error) {
  console.error(error.message);
  for (const cause of error.errors ?? []) console.error(`- ${cause.message}`);
  process.exitCode = 1;
}
