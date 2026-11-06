#!/usr/bin/env bun
/** Measures the real canonical save path using only the worktree fixture. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
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

/**
 * Counts durable rows without assuming a provider-specific projection exists. Two tables are counted indirectly,
 * because the server deletes their rows after the fact: a writer receipt is deleted once its save is acknowledged,
 * and an item's content appends are cleared when the whole item is rewritten. Each accepted write page commits one
 * durable revision and inserts one receipt, so receipts are the distinct revisions; each append is one event.
 */
export function summarizeRows(rows, deltas, itemRows = 0) {
  const { types, projections, revisions } = countRowKinds(rows);
  const perSavedDelta = (count) => deltas ? count / deltas : null;
  const contentAppends = types["item.content-appended"] ?? 0;
  return { total: rows.length, types, itemProjections: projections, itemRows, contentAppends, writerReceipts: revisions.size,
    rowsPerSavedDelta: perSavedDelta(rows.length),
    perSavedDelta: { itemRows: perSavedDelta(itemRows), contentAppends: perSavedDelta(contentAppends), writerReceipts: perSavedDelta(revisions.size) } };
}

function countRowKinds(rows) {
  const types = {};
  const projections = {};
  const revisions = new Set();
  for (const row of rows) {
    const payload = JSON.parse(row.envelope_json).payload;
    types[payload.type] = (types[payload.type] ?? 0) + 1;
    if (payload.type === "item.recorded") {
      const projection = payload.item?.payload?.projection ?? "none";
      projections[projection] = (projections[projection] ?? 0) + 1;
    }
    if (row.durable_revision !== undefined) revisions.add(row.durable_revision);
  }
  return { types, projections, revisions };
}

/** Joins accepted sequence ranges to saved watermarks; missing evidence stays visible. */
export function summarizeSaves(records) {
  const accepted = new Map();
  const saved = new Map();
  const commits = [];
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    const data = record.d;
    const epoch = cursorEpoch(data.through);
    const through = cursorSequence(data.through);
    const from = cursorSequence(data.from);
    if (data.phase === "accepted") {
      for (let sequence = from + 1; sequence <= through; sequence += 1) {
        const key = `${epoch}:${sequence}`;
        if (!accepted.has(key)) accepted.set(key, record.t);
      }
    } else if (data.phase === "saved") {
      commits.push(data.events);
      for (const sequence of accepted.keys()) {
        if (isUnsavedThrough(sequence, epoch, through, saved)) saved.set(sequence, record.t);
      }
    }
  }
  const lags = [...saved].map(([sequence, time]) => time - accepted.get(sequence));
  return { source: "agent.canonical frames received on the local socket; saved frames acknowledge committed batches", commits: commits.length, eventsPerCommit: commits, acceptedEvents: accepted.size, unmatchedAcceptedEvents: accepted.size - saved.size, lag: summarizeLatency(lags) };
}

function cursorEpoch(cursor) { return cursor?.epoch ?? "legacy"; }
function cursorSequence(cursor) { return cursor?.sequence ?? cursor; }
function isUnsavedThrough(key, epoch, through, saved) {
  return key.startsWith(`${epoch}:`) && Number(key.slice(epoch.length + 1)) <= through && !saved.has(key);
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
  const offsets = new Map();
  const collect = async () => {
    // Each run writes its own `<threadId>.<runId>.jsonl`; older builds share `<threadId>.jsonl`.
    const threads = NodePath.join(paths.devDir, "diagnostics", "t");
    const files = NodeFS.existsSync(threads)
      ? NodeFS.readdirSync(threads).filter((name) => name.startsWith(`${threadId}.`) && name.endsWith(".jsonl")).map((name) => NodePath.join(threads, name))
      : [];
    const processes = NodePath.join(paths.devDir, "diagnostics", "p");
    if (NodeFS.existsSync(processes)) files.push(...NodeFS.readdirSync(processes).filter((name) => name.endsWith(".jsonl")).map((name) => NodePath.join(processes, name)));
    for (const file of files) {
      if (!NodeFS.existsSync(file)) continue;
      assertRuntimeFileSafe(file, "diagnostic recording");
      await collectDiagnosticFile(file, threadId, since, records, offsets);
    }
    const failures = [...records.values()].filter((record) => record.ch === "progress.save-failed" && record.d.exhausted);
    if (failures.length) state.saveFailure = failures.at(-1).d.error;
  };
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(collect); }, 1000);
  return { async stop() { clearInterval(timer); await pending; await collect(); return [...records.values()]; } };
}

async function sendTurn(socket, threadId, config, state, timeoutMs) {
  state.persisted = null;
  state.error = null;
  state.saveFailure = null;
  await socket.rpc("agent.send", { threadId, content: JSON.stringify(config), messageId: NodeCrypto.randomUUID(), provider: "codex", model: WORKLOAD_MODEL, permissionMode: "full" });
  const deadline = Date.now() + timeoutMs;
  while (!state.persisted && Date.now() < deadline) {
    if (state.interrupted) throw new Error("Measurement interrupted by signal");
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
  const state = { progress: [] };
  const socket = await openRuntimeVerificationSocket(root, (push) => captureHeavyPush(push, receipt, state));
  const { Database } = await import("bun:sqlite");
  const dbPath = NodePath.join(paths.devDir, "db", "app.sqlite");
  assertRuntimeFileSafe(dbPath, "fixture database");
  const db = new Database(dbPath, { readonly: true });
  const readRows = () => Array.from(db.query("SELECT envelope_json, accepted_sequence, durable_revision, persisted_at FROM canonical_agent_events WHERE thread_id = ? ORDER BY durable_revision, accepted_sequence").iterate(receipt.threadId), compactRow);
  let original;
  let changed = false;
  let sampler;
  let diagnostics;
  const onSignal = createInterruptHandler(state);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
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
    state.progress = [];
    receipt.startedAt = since;
    receipt.logOffset = NodeFS.statSync(NodePath.join(paths.logsDir, "server.log")).size;
    receipt.databaseBefore = databaseBytes(dbPath);
    receipt.processBefore = await processSnapshot(paths);
    diagnostics = diagnosticCollector(paths, thread.id, since, state);
    sampler = new HealthSampler(ports.healthUrl, receipt.health, receipt.workerQueue);
    sampler.start();
    const statsPath = NodePath.join(directory, "emitted.json");
    try {
      await sendTurn(socket, thread.id, { ...options, grow: 0, statsPath }, state, (options.duration + 240) * 1000);
    } catch (error) { receipt.error = error.message; }
    recordTurnResult(receipt, state, statsPath, readRows().slice(previousRows),
      (turnId) => db.query("SELECT count(*) AS count FROM canonical_agent_items WHERE turn_id = ?").get(turnId).count);
    receipt.checkpoint = db.query("SELECT phase, terminal_outcome, error, last_accepted_sequence, last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1").get(thread.id);
    receipt.databaseAfter = databaseBytes(dbPath);
    receipt.databaseGrowthBytes = receipt.databaseAfter.total - receipt.databaseBefore.total;
    receipt.processAfter = await processSnapshot(paths);
  } catch (error) { receipt.error = error.message; receipt.outcome = "errored"; }
  finally {
    try {
      await finishMeasurements(sampler, diagnostics, directory, receipt, state.progress);
      receipt.serverDropLogLines = await countDropLines(NodePath.join(paths.logsDir, "server.log"), receipt.logOffset ?? 0, receipt.threadId);
      finalizeOutcome(receipt, state.interrupted);
    } catch (error) { receipt.error = error.message; receipt.outcome = "failed"; }
    await restoreFixture(socket, receipt, state, changed, original);
    db.close();
    await socket.close();
    write();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  printSummary(receipt, receiptPath);
  return receipt;
}

/** Requires delivery, terminal, and commit evidence before reporting a clean run. */
export function finalizeOutcome(receipt, interrupted) {
  const pieces = receipt.delivery?.savedPieces ?? [];
  const savedTimes = (receipt.saves.savedTimes ?? []).sort((a, b) => a.at - b.at);
  const lags = pieces.map((piece) => {
    const saved = savedTimes.find((save) => save.through?.epoch === piece.position?.epoch && save.through.sequence >= piece.position.sequence);
    return saved ? saved.at - piece.at : null;
  }).filter((lag) => lag !== null);
  receipt.endToEndLag = summarizeLatency(lags);
  receipt.endToEndLag.unmatchedSavedPieces = pieces.length - lags.length;
  receipt.persistedAtLag = summarizeLatency(pieces.filter((piece) => Number.isFinite(piece.persistedAt)).map((piece) => piece.persistedAt - piece.at));
  receipt.persistedAtLag.unmatchedSavedPieces = pieces.length - receipt.persistedAtLag.count;
  receipt.lagExcludesLostPieces = true;
  delete receipt.saves.savedTimes;
  if (receipt.delivery) delete receipt.delivery.savedPieces;
  const failures = [interrupted, receipt.error, !receipt.emitted?.complete, receipt.delivery?.pieces.lost,
    receipt.delivery?.tools.lost, Object.values({ ...receipt.serverDropLogLines }).some((count) => count > 0), !receipt.terminalEvent, !receipt.largeOutput?.saved, receipt.saves.unmatchedAcceptedEvents, receipt.endToEndLag.unmatchedSavedPieces];
  if (failures.some(Boolean)) receipt.outcome = "failed";
}

/** Lets the first signal reach restoration and forces exit on a second signal. */
export function createInterruptHandler(state) {
  return () => {
    if (state.interrupted) process.exit(130);
    state.interrupted = true;
  };
}

if (import.meta.main) {
  runHeavyStream(parseHeavyArguments(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
function captureHeavyPush(push, receipt, state) {
  if (push.data?.threadId !== receipt.threadId) return;
  if (push.channel === "agent.canonical" && push.data.phase !== "recovery") {
    const { phase, epoch, from, through, events } = push.data;
    state.progress.push({ t: Date.now(), d: { phase, from: { epoch, sequence: from }, through: { epoch, sequence: through }, events: events.length } });
  }
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

function recordTurnResult(receipt, state, statsPath, rows, countItemRows) {
  recordOutcome(receipt, state);
  receipt.emitted = NodeFS.existsSync(statsPath) ? JSON.parse(NodeFS.readFileSync(statsPath, "utf8")) : null;
  receipt.delivery = auditDelivery(rows, receipt.emitted);
  const turnId = rows.map((row) => JSON.parse(row.envelope_json)).find((event) => event.payload.type === "turn.started")?.routing?.turnId;
  receipt.rows = summarizeRows(rows, receipt.delivery.pieces.saved, turnId ? countItemRows(turnId) : 0);
  receipt.lastSavedEvent = rows.length ? JSON.parse(rows.at(-1).envelope_json).payload.type : null;
  receipt.terminalEvent = savedTerminal(rows, turnId);
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
  const index = rows.findIndex((row) => row.largeOutputSaved ?? hasLargeOutput(JSON.parse(row.envelope_json)));
  return { bytes: 300 * 1024, saved: index >= 0, savedAfter: index >= 0 && index < rows.length - 1 };
}

/** Restores the worktree CLI even when a blocked execution cannot acknowledge Stop. */
export async function restoreFixture(socket, receipt, state, changed, original) {
  try {
    if (receipt.threadId && !state.persisted) await socket.rpc("agent.stop", { threadId: receipt.threadId });
  } catch (error) { receipt.cleanup.stopError = error.message; }
  try {
    if (changed) await socket.rpc("settings.update", { provider: { cli: { codex: original } } });
    receipt.cleanup.settingsRestored = true;
  } catch (error) { receipt.cleanup.error = error.message; }
}

function printSummary(receipt, receiptPath) {
  const { options } = receipt;
  const summary = { duration: options.duration, outcome: receipt.outcome, error: receipt.error, pieces: receipt.delivery?.pieces, tools: receipt.delivery?.tools, serverDropLogLines: receipt.serverDropLogLines, rows: receipt.rows?.total, rowsPerSavedDelta: receipt.rows?.rowsPerSavedDelta,
    itemRows: receipt.rows?.itemRows, contentAppends: receipt.rows?.contentAppends, writerReceipts: receipt.rows?.writerReceipts,
    perSavedDelta: receipt.rows?.perSavedDelta, commits: receipt.saves.commits, acceptToSaveLag: receipt.saves.lag, endToEndLag: receipt.endToEndLag, persistedAtLag: receipt.persistedAtLag, lagExcludesLostPieces: receipt.lagExcludesLostPieces, largeOutput: receipt.largeOutput, terminalEvent: receipt.terminalEvent, cleanup: receipt.cleanup, receiptPath };
  process.stdout.write(JSON.stringify(summary) + "\n");
}

async function collectDiagnosticFile(file, threadId, since, records, offsets) {
  const stat = NodeFS.statSync(file);
  const previous = offsets.get(file);
  const start = diagnosticOffset(previous, stat);
  if (start === stat.size) return;
  let consumed = start;
  for await (const line of NodeReadline.createInterface({ input: NodeFS.createReadStream(file, { start, end: stat.size - 1 }), crlfDelay: Infinity })) {
    consumed += Buffer.byteLength(line) + 1;
    if (consumed > stat.size) break;
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.t >= since && isMeasurementRecord(record, threadId)) {
      const { phase, from, through, events, exhausted, error, intervalMs } = record.d;
      const compact = { t: record.t, ch: record.ch, d: { phase, from, through, events, exhausted, error, intervalMs } };
      records.set(JSON.stringify(compact), compact);
    }
  }
  offsets.set(file, { ino: stat.ino, size: Math.min(consumed, stat.size) });
}
function diagnosticOffset(previous, stat) {
  return previous?.ino === stat.ino && previous.size <= stat.size ? previous.size : 0;
}
async function finishMeasurements(sampler, diagnostics, directory, receipt, progress) {
  await sampler?.stop();
  const records = await diagnostics?.stop() ?? [];
  NodeFS.writeFileSync(NodePath.join(directory, "diagnostics.json"), JSON.stringify(records));
  NodeFS.writeFileSync(NodePath.join(directory, "progress.json"), JSON.stringify(progress));
  receipt.saves = summarizeSaves(progress);
  receipt.saves.savedTimes = progress.filter((record) => record.d.phase === "saved").map((record) => ({ at: record.t, through: record.d.through }));
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

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function hasLargeOutput(envelope) {
  let saved = false;
  const full = "HEAVY_OUTPUT:" + "x".repeat(300 * 1024 - 13) + "\n";
  visit(envelope, (value) => {
    if (typeof value.output !== "string" || !value.output.includes("HEAVY_OUTPUT:")) return;
    if (value.output === full) saved = true;
    if (value.outputArtifactPath) {
      if (NodeFS.existsSync(value.outputArtifactPath)) {
        assertRuntimeFileSafe(value.outputArtifactPath, "large output artifact");
        if (NodeFS.readFileSync(value.outputArtifactPath, "utf8") === full) saved = true;
      }
    }
  });
  return saved;
}

function compactRow(row) {
  const envelope = JSON.parse(row.envelope_json);
  const pieces = new Set();
  const tools = new Set();
  visit(envelope.payload, (value) => {
    for (const text of Object.values(value)) {
      if (typeof text === "string") for (const match of text.matchAll(/\bpiece (\d+)\n/g)) pieces.add(Number(match[1]));
    }
    if (value.toolCallId && typeof value.output === "string") tools.add(value.toolCallId);
  });
  return { ...row, largeOutputSaved: hasLargeOutput(envelope), pieces: [...pieces], tools: [...tools], position: envelope.progressPosition,
    envelope_json: JSON.stringify({ ...envelope, payload: { type: envelope.payload.type, item: { payload: { projection: envelope.payload.item?.payload?.projection } } } }) };
}

/** Compares distinct durable content with the fixture's independent send ledger. */
export function auditDelivery(rows, emitted) {
  const pieces = new Map();
  const tools = new Set();
  for (const raw of rows) {
    const row = raw.pieces ? raw : compactRow(raw);
    for (const index of row.pieces) if (!pieces.has(index)) pieces.set(index, { position: row.position, persistedAt: Date.parse(row.persisted_at) });
    for (const id of row.tools) tools.add(id);
  }
  const sentPieces = emitted?.pieces ?? [];
  const sentTools = emitted?.tools ?? [];
  const savedPieces = sentPieces.filter((piece) => pieces.has(piece.index));
  const savedTools = sentTools.filter((id) => tools.has(id));
  return { pieces: { sent: sentPieces.length, saved: savedPieces.length, lost: sentPieces.length - savedPieces.length },
    tools: { sent: sentTools.length, saved: savedTools.length, lost: sentTools.length - savedTools.length },
    savedPieces: savedPieces.map((piece) => ({ ...piece, ...pieces.get(piece.index) })) };
}

/** Finds a durable terminal even when final publication rows follow it. */
export function savedTerminal(rows, turnId) {
  if (!turnId) return null;
  for (const row of rows) {
    const event = JSON.parse(row.envelope_json);
    if ((event.turnId ?? event.routing?.turnId) === turnId && /^turn\.(completed|cancelled|interrupted|errored)$/.test(event.payload.type)) return event.payload.type;
  }
  return null;
}

/** Counts thread-local drop log lines by reason, never treating them as event counts. */
export async function countDropLines(file, start, threadId) {
  const counts = { queueCapacity: 0, acceptanceRejected: 0, deliveryFailed: 0, other: 0 };
  const reasons = new Map([["queue-capacity", "queueCapacity"], ["acceptance-rejected", "acceptanceRejected"], ["delivery-failed", "deliveryFailed"]]);
  for await (const line of NodeReadline.createInterface({ input: NodeFS.createReadStream(file, { start }), crlfDelay: Infinity })) {
    const marker = line.indexOf("Codex observation dropped");
    if (marker < 0) continue;
    const data = JSON.parse(line.slice(line.indexOf("{", marker)));
    if (threadId && data.threadId === threadId) counts[reasons.get(data.reason) ?? "other"] += 1;
  }
  return counts;
}


