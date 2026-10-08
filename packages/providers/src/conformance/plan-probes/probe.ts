import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { z } from "zod";
import { containedPath, hygieneSnapshot, listFiles, providerSchema, scenarioSchema, type CaptureVersion, type ProbeContext, type ProbeEnd } from "./runtime.js";
import { probeCodex } from "./codex.js";
import { probeClaude } from "./claude.js";
import { probeCopilot } from "./copilot.js";
import { probeCursor } from "./cursor.js";
import { probeDevin } from "./devin.js";
import { probeOpencode } from "./opencode.js";
import { sanitizePlanProtocolCapture } from "./fixture.js";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../../..");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const probes = { codex: probeCodex, claude: probeClaude, copilot: probeCopilot, cursor: probeCursor, devin: probeDevin, opencode: probeOpencode };

function exclusiveDirectory(path: string): void {
  if (!containedPath(root, path)) throw new Error("Output escapes checkout");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.mkdirSync(path);
}

function parseCaptureArgs(args: string[]) {
  const provider = providerSchema.parse(args[0]);
  const scenario = scenarioSchema.parse(args[1]);
  if (provider !== "codex" && scenario.startsWith("questions-")) throw new Error("Question lifecycle variants are Codex-only experiments");
  if (args[2] !== "--run" || (args[4] !== undefined && args[4] !== "--timeout-ms")) throw new Error("Expected capture PROVIDER SCENARIO --run SLUG [--timeout-ms N]");
  const run = slug.parse(args[3]);
  const timeout = z.coerce.number().int().min(1000).max(900000).parse(args[5] ?? 120000);
  if (args.length > 6) throw new Error("Unexpected capture arguments");
  return { provider, scenario, run, timeout };
}

async function capture(args: string[]): Promise<void> {
  const { provider, scenario, run, timeout } = parseCaptureArgs(args);
  const rawDirectory = NodePath.join(root, "packages/providers/.conformance-raw/plan", run);
  const providerHome = NodePath.join(root, ".dev/provider-homes", provider, run);
  const fixtureRepo = NodePath.join(root, ".dev/fixture-repo");
  if (!NodeFS.existsSync(NodePath.join(fixtureRepo, ".git")) || !containedPath(root, fixtureRepo)) throw new Error("Missing or escaped fixture repository");
  exclusiveDirectory(rawDirectory);
  exclusiveDirectory(providerHome);
  const before = hygieneSnapshot();
  const fixtureBefore = listFiles(fixtureRepo);
  const children: NodeChildProcess.ChildProcessWithoutNullStreams[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const controller = new AbortController();
  const measured: { version: CaptureVersion | null } = { version: null };
  let end: ProbeEnd = { kind: "blocked" };
  let recordedBytes = 0;
  let recordedMessages = 0;
  const context: ProbeContext = {
    provider, scenario, fixtureRepo, providerHome, rawDirectory, signal: controller.signal,
    record(message) {
      const encoded = `${JSON.stringify(message)}\n`;
      recordedBytes += Buffer.byteLength(encoded);
      if (++recordedMessages > 10000 || recordedBytes > 32_000_000) throw new Error("Raw capture limit exceeded");
      NodeFS.appendFileSync(NodePath.join(rawDirectory, "messages.jsonl"), encoded);
    },
    version(value) { measured.version = value; },
    onCleanup(cleanup) { cleanups.push(cleanup); },
    mayWrite(path) { return containedPath(providerHome, path) || containedPath(fixtureRepo, path); },
    spawn(command, argv, extraEnv) {
      const child = NodeChildProcess.spawn(command, argv, { cwd: fixtureRepo, env: { ...process.env, DISABLE_AUTOUPDATER: "1", DEVIN_NO_AUTO_UPDATE: "1", ...extraEnv }, windowsHide: true, stdio: "pipe" });
      children.push(child);
      NodeFS.appendFileSync(NodePath.join(rawDirectory, "processes.jsonl"), `${JSON.stringify({ pid: child.pid, command, args: argv, at: new Date().toISOString() })}\n`);
      child.stderr.on("data", (chunk: Buffer) => NodeFS.appendFileSync(NodePath.join(rawDirectory, "stderr.log"), chunk));
      return child;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    end = await Promise.race([probes[provider](context), new Promise<ProbeEnd>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeout);
    })]);
  } catch (error) {
    NodeFS.writeFileSync(NodePath.join(rawDirectory, "failure.txt"), String(error));
  } finally {
    clearTimeout(timer);
    controller.abort();
    const cleanupResults = await Promise.allSettled([...cleanups.map((cleanup) => cleanup()), ...children.map(stopOwned)]);
    const failures = cleanupResults.filter((result) => result.status === "rejected");
    if (failures.length) {
      end = { kind: "blocked" };
      NodeFS.writeFileSync(NodePath.join(rawDirectory, "cleanup-failure.txt"), failures.map((failure) => String(failure.reason)).join("\n"));
    }
  }
  const after = hygieneSnapshot();
  const changedConfigs = Object.keys(before.configs).filter((file) => before.configs[file] !== after.configs[file]);
  const changedGlobalPlans = Object.keys(after.plans).filter((file) => before.plans[file] !== after.plans[file]);
  const hygiene = { before, after, changedConfigs, changedGlobalPlans, bookkeepingChanged: before.bookkeeping !== after.bookkeeping, fixtureBefore, fixtureAfter: listFiles(fixtureRepo), providerFiles: listFiles(providerHome), spawnedPids: children.map((child) => child.pid), allSpawnedExited: children.every((child) => child.exitCode !== null || child.signalCode !== null) };
  NodeFS.writeFileSync(NodePath.join(rawDirectory, "hygiene.json"), JSON.stringify(hygiene, null, 2));
  NodeFS.writeFileSync(NodePath.join(rawDirectory, "metadata.json"), JSON.stringify({ providerId: provider, scenario, ...measured.version, end, roots: { providerHome, fixtureRepo, userHome: NodeOS.homedir() }, capturedAt: new Date().toISOString() }, null, 2));
  process.stdout.write(`${JSON.stringify({ run, end, version: measured.version, changedConfigs, changedGlobalPlans, bookkeepingChanged: hygiene.bookkeepingChanged, rawDirectory })}\n`);
  process.exitCode = resultCode(changedConfigs.length + changedGlobalPlans.length, end);
}

function resultCode(hygieneFailures: number, end: ProbeEnd): number {
  if (hygieneFailures) return 1;
  if (end.kind === "blocked") return 2;
  return end.kind === "timeout" ? 3 : 0;
}

async function stopOwned(child: NodeChildProcess.ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (hostRuntime.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = NodeChildProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
  } else child.kill("SIGTERM");
  await closed;
}

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (action === "capture") await capture(args);
  else if (action === "sanitize" && args[1] === "--reviewed") {
    const run = slug.parse(args[0]);
    const file = sanitizePlanProtocolCapture({ runDirectory: NodePath.join(root, "packages/providers/.conformance-raw/plan", run), outputDirectory: NodePath.join(root, "packages/providers/src/conformance/fixtures/plan-protocol"), reviewed: true });
    process.stdout.write(`${file}\n`);
  } else throw new Error("Expected capture or sanitize RUN --reviewed");
}

void main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
