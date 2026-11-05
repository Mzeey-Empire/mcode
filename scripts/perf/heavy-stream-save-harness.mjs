#!/usr/bin/env bun
/** Measures the real canonical save path using only the worktree fixture. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { getRuntimePaths, resolveRepoRoot, assertRuntimeFileSafe } from "../agent/runtime-contract.mjs";
import { renderFixtureWrapper } from "../../.agents/skills/verify-mcode/scripts/codex-protocol-notices.mjs";
import { openRuntimeVerificationSocket } from "../../.agents/skills/verify-mcode/scripts/runtime.mjs";
import { requireLocalRuntime, requireFixtureWorkspace, currentFixtureBranch, HealthSampler, readMemorySnapshot, summarizeLatency, ensureRealDirectory, WORKLOAD_MODEL } from "./seven-thread-live-harness.mjs";

/** Rejects ambiguous workload options before touching the runtime. */
export function parseHeavyArguments(argv) {
  const result = { duration: 120, rate: 36, grow: 0 };
  const names = { "--duration": "duration", "--rate": "rate", "--grow-thread": "grow" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]];
    const value = Number(argv[index + 1]);
    if (!key || seen.has(key) || !Number.isSafeInteger(value) || value <= 0) throw new Error("Expected positive integer --duration, --rate, or --grow-thread");
    result[key] = value;
    seen.add(key);
  }
  return result;
}

/** Counts durable rows without assuming a provider-specific projection exists. */
export function summarizeRows(rows, deltas) {
  const types = {};
  const projections = {};
  for (const row of rows) {
    const payload = JSON.parse(row.envelope_json).payload;
    types[payload.type] = (types[payload.type] ?? 0) + 1;
    if (payload.type === "item.recorded") {
      const projection = payload.item?.payload?.projection ?? "none";
      projections[projection] = (projections[projection] ?? 0) + 1;
    }
  }
  return { total: rows.length, types, itemProjections: projections, rowsPerStreamedDelta: deltas ? rows.length / deltas : null };
}

/** Joins accepted sequence ranges to saved watermarks; missing evidence stays visible. */
export function summarizeSaves(records) {
  const accepted = new Map();
  const saved = new Map();
  const commits = [];
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    const data = record.d;
    if (data.phase === "accepted") {
      for (let sequence = data.from + 1; sequence <= data.through; sequence += 1) {
        if (!accepted.has(sequence)) accepted.set(sequence, record.t);
      }
    } else if (data.phase === "saved") {
      commits.push(data.events);
      for (const sequence of accepted.keys()) {
        if (sequence <= data.through && !saved.has(sequence)) saved.set(sequence, record.t);
      }
    }
  }
  const lags = [...saved].map(([sequence, time]) => time - accepted.get(sequence));
  return { source: "push.canonical phase=saved (save notifications, one per committed batch)", commits: commits.length, eventsPerCommit: commits, acceptedEvents: accepted.size, unmatchedAcceptedEvents: accepted.size - saved.size, lag: summarizeLatency(lags) };
}

function databaseBytes(path) {
  const size = (file) => NodeFS.existsSync(file) ? NodeFS.statSync(file).size : 0;
  const main = size(path);
  const wal = size(`${path}-wal`);
  return { main, wal, total: main + wal };
}

async function processSnapshot(paths) {
  const memory = await readMemorySnapshot(paths);
  const pid = Number(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "server.pid"), "utf8").trim());
  let cpuMs = null;
  if (process.platform === "win32" && Number.isSafeInteger(pid) && pid > 0) {
    const result = NodeChildProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`], { encoding: "utf8", windowsHide: true });
    if (result.status === 0) cpuMs = Number(result.stdout.trim());
  }
  return { ...memory, pid, cpuMs, cpuGap: cpuMs === null ? "Server process CPU time unavailable" : null };
}

function diagnosticCollector(paths, threadId, since, state) {
  const records = new Map();
  const collect = () => {
    const files = [NodePath.join(paths.devDir, "diagnostics", "t", `${threadId}.jsonl`), NodePath.join(paths.devDir, "diagnostics", "t", `${threadId}.1.jsonl`)];
    const processes = NodePath.join(paths.devDir, "diagnostics", "p");
    if (NodeFS.existsSync(processes)) files.push(...NodeFS.readdirSync(processes).filter((name) => name.endsWith(".jsonl")).map((name) => NodePath.join(processes, name)));
    for (const file of files) {
      if (!NodeFS.existsSync(file)) continue;
      assertRuntimeFileSafe(file, "diagnostic recording");
      collectDiagnosticFile(file, threadId, since, records);
    }
    const failures = [...records.values()].filter((record) => record.ch === "progress.save-failed" && record.d.exhausted);
    if (failures.length) state.saveFailure = failures.at(-1).d.error;
  };
  const timer = setInterval(collect, 1000);
  return { stop() { clearInterval(timer); collect(); return [...records.values()]; } };
}

async function sendTurn(socket, threadId, config, state, timeoutMs) {
  state.persisted = null;
  state.error = null;
  state.saveFailure = null;
  await socket.rpc("agent.send", { threadId, content: JSON.stringify(config), messageId: NodeCrypto.randomUUID(), provider: "codex", model: WORKLOAD_MODEL, permissionMode: "full" });
  const deadline = Date.now() + timeoutMs;
  while (!state.persisted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (state.saveFailure && fixtureFinished(config.statsPath)) throw new Error(state.saveFailure);
  }
  if (!state.persisted) throw new Error("Turn did not persist before the bounded drain deadline");
}

/** Runs one measured turn, retaining the fixture thread and a local receipt for comparison. */
export async function runHeavyStream(options) {
  const root = resolveRepoRoot();
  const paths = getRuntimePaths(root);
  const ports = requireLocalRuntime(root);
  const directory = NodePath.join(paths.devDir, "perf", `heavy-stream-${Date.now()}-${NodeCrypto.randomUUID()}`);
  ensureRealDirectory(directory, paths.devDir);
  const receiptPath = NodePath.join(directory, "receipt.json");
  const receipt = { options, threadId: null, outcome: null, error: null, cleanup: {}, health: { samples: [] }, workerQueue: { samples: [], omittedSamples: 0, unavailableSamples: 0, summary: { sampleCount: 0, maxPending: 0, maxPendingBytes: 0, maxActiveExecutions: 0, maxQueuedPerWorker: 0, maxInFlightWorkers: 0 } } };
  const write = () => NodeFS.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const state = {};
  const socket = await openRuntimeVerificationSocket(root, (push) => captureHeavyPush(push, receipt, state));
  const { Database } = await import("bun:sqlite");
  const dbPath = NodePath.join(paths.devDir, "db", "app.sqlite");
  assertRuntimeFileSafe(dbPath, "fixture database");
  const db = new Database(dbPath, { readonly: true });
  const readRows = () => db.query("SELECT envelope_json, accepted_sequence FROM canonical_agent_events WHERE thread_id = ? ORDER BY durable_revision, accepted_sequence").all(receipt.threadId);
  let original;
  let changed = false;
  let sampler;
  let diagnostics;
  try {
    if (await socket.rpc("agent.activeCount", {}) !== 0) throw new Error("Runtime is busy; refusing to replace Codex CLI");
    const workspace = await requireFixtureWorkspace(socket, paths.fixtureRepoDir);
    original = await readCodexSetting(socket);
    const wrapper = NodePath.join(directory, "codex-heavy-stream.cmd");
    NodeFS.writeFileSync(wrapper, renderFixtureWrapper(process.execPath, NodePath.join(root, ".agents/skills/verify-mcode/scripts/heavy-stream-provider-fixture.mjs")));
    changed = true;
    await socket.rpc("settings.update", { provider: { cli: { codex: wrapper } } });
    const thread = await socket.rpc("thread.create", { workspaceId: workspace.id, title: `Heavy stream baseline ${NodePath.basename(directory)}`, mode: "direct", branch: currentFixtureBranch(paths.fixtureRepoDir) });
    receipt.threadId = thread.id;
    write();
    await socket.rpc("push.setThreadSubscriptions", { threadIds: [thread.id], cursors: { [thread.id]: 0 } });
    if (options.grow) await growThread(socket, receipt, state, directory, db);
    const previousRows = readRows().length;
    const since = Date.now();
    receipt.startedAt = since;
    receipt.databaseBefore = databaseBytes(dbPath);
    receipt.processBefore = await processSnapshot(paths);
    diagnostics = diagnosticCollector(paths, thread.id, since, state);
    sampler = new HealthSampler(ports.healthUrl, receipt.health, receipt.workerQueue);
    sampler.start();
    const statsPath = NodePath.join(directory, "emitted.json");
    try {
      await sendTurn(socket, thread.id, { ...options, grow: 0, statsPath }, state, (options.duration + 240) * 1000);
    } catch (error) { receipt.error = error.message; }
    recordTurnResult(receipt, state, statsPath, readRows().slice(previousRows));
    receipt.checkpoint = db.query("SELECT phase, terminal_outcome, error, last_accepted_sequence, last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1").get(thread.id);
    receipt.databaseAfter = databaseBytes(dbPath);
    receipt.databaseGrowthBytes = receipt.databaseAfter.total - receipt.databaseBefore.total;
    receipt.processAfter = await processSnapshot(paths);
  } catch (error) { receipt.error = error.message; receipt.outcome = "errored"; }
  finally {
    await finishMeasurements(sampler, diagnostics, directory, receipt);
    await restoreFixture(socket, receipt, state, changed, original);
    db.close();
    await socket.close();
    write();
  }
  printSummary(receipt, receiptPath);
  return receipt;
}

if (import.meta.main) {
  runHeavyStream(parseHeavyArguments(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
function captureHeavyPush(push, receipt, state) {
  if (push.data?.threadId !== receipt.threadId) return;
  if (push.channel === "turn.persisted") state.persisted = push.data;
  if (push.channel === "agent.event" && push.data.type === "error") state.error = push.data;
}

async function growThread(socket, receipt, state, directory, db) {
  const { options, threadId } = receipt;
  const started = Date.now();
  try {
    await sendTurn(socket, threadId, { grow: options.grow, statsPath: NodePath.join(directory, "warmup.json") }, state, 600_000);
  } finally {
    const items = db.query("SELECT count(*) AS count FROM canonical_agent_items WHERE thread_id = ?").get(threadId).count;
    receipt.warmup = { elapsedMs: Date.now() - started, requestedItems: options.grow, savedItems: items, capped: items < options.grow };
  }
  if (receipt.warmup.savedItems < options.grow) throw new Error("Warm-up reached its cap before the requested item count; measured turn was not started");
}

function fixtureFinished(statsPath) {
  if (!NodeFS.existsSync(statsPath)) return false;
  return JSON.parse(NodeFS.readFileSync(statsPath, "utf8")).complete === true;
}

function recordTurnResult(receipt, state, statsPath, rows) {
  recordOutcome(receipt, state);
  receipt.emitted = NodeFS.existsSync(statsPath) ? JSON.parse(NodeFS.readFileSync(statsPath, "utf8")) : null;
  const deltas = streamedDeltaCount(receipt.emitted);
  receipt.rows = summarizeRows(rows, deltas);
  receipt.lastSavedEvent = rows.length ? JSON.parse(rows.at(-1).envelope_json).payload.type : null;
  receipt.lastSavedIsTurnEnd = receipt.lastSavedEvent === "turn.ended";
  receipt.largeOutput = auditLargeOutput(rows);
}

function recordOutcome(receipt, state) {
  receipt.outcome = state.persisted?.outcome ?? "errored";
  receipt.error ??= state.error?.message ?? state.error?.error ?? null;
}

/** Counts text and reasoning pieces independently of lifecycle and tool notifications. */
export function streamedDeltaCount(emitted) {
  if (!emitted) return 0;
  return (emitted.counts["item/agentMessage/delta"] ?? 0) + (emitted.counts["item/reasoning/summaryTextDelta"] ?? 0);
}

/** Proves the large payload itself and subsequent records reached durable storage. */
export function auditLargeOutput(rows) {
  const index = rows.findIndex((row) => row.envelope_json.includes("HEAVY_OUTPUT:") && row.envelope_json.length >= 300 * 1024);
  return { bytes: 300 * 1024, saved: index >= 0, savedAfter: index >= 0 && index < rows.length - 1 };
}

async function restoreFixture(socket, receipt, state, changed, original) {
  try {
    if (receipt.threadId && !state.persisted) await socket.rpc("agent.stop", { threadId: receipt.threadId });
    if (changed) await socket.rpc("settings.update", { provider: { cli: { codex: original } } });
    receipt.cleanup.settingsRestored = true;
  } catch (error) { receipt.cleanup.error = error.message; }
}

function printSummary(receipt, receiptPath) {
  const { options } = receipt;
  const summary = { duration: options.duration, outcome: receipt.outcome, error: receipt.error, rows: receipt.rows?.total, rowsPerDelta: receipt.rows?.rowsPerStreamedDelta, commits: receipt.saves.commits, lag: receipt.saves.lag, largeOutput: receipt.largeOutput, lastSavedIsTurnEnd: receipt.lastSavedIsTurnEnd, receiptPath };
  process.stdout.write(JSON.stringify(summary) + "\n");
}

function collectDiagnosticFile(file, threadId, since, records) {
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.t >= since && isMeasurementRecord(record, threadId)) records.set(line, record);
  }
}
async function finishMeasurements(sampler, diagnostics, directory, receipt) {
  await sampler?.stop();
  const records = diagnostics?.stop() ?? [];
  NodeFS.writeFileSync(NodePath.join(directory, "diagnostics.json"), JSON.stringify(records));
  receipt.saves = summarizeSaves(records.filter((record) => record.ch === "push.canonical"));
  receipt.stalls = summarizeLatency(records.filter((record) => record.ch === "app.stall").map((record) => record.d.intervalMs));
  receipt.health.summary = summarizeLatency(receipt.health.samples);
  receipt.saveFailures = records.filter((record) => record.ch === "progress.save-failed");
  if (receipt.saveFailures.length) receipt.error = receipt.saveFailures.at(-1).d.error;
}

/** Keeps thread-local save evidence and worktree process stalls within the receipt. */
export function isMeasurementRecord(record, threadId) {
  return record.ch === "app.stall" || (record.th === threadId && ["push.canonical", "progress.save-failed"].includes(record.ch));
}

async function readCodexSetting(socket) {
  return (await socket.rpc("settings.get", {}))?.provider?.cli?.codex ?? "";
}


