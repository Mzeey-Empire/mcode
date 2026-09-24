#!/usr/bin/env bun
/**
 * Runs one controlled, seven-thread provider workload through the public Mcode
 * WebSocket contract. The workload uses the existing Codex protocol fixture,
 * so it makes no upstream provider calls.
 *
 * Usage:
 *   bun scripts/perf/seven-thread-live-harness.mjs --run --confirm-run --label before
 *   bun scripts/perf/seven-thread-live-harness.mjs --cleanup <receipt-path> --confirm-cleanup
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import {
  assertInsideDevDir,
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "../agent/runtime-contract.mjs";
import { renderFixtureWrapper } from "../../.agents/skills/verify-mcode/scripts/codex-protocol-notices.mjs";
import { openRuntimeVerificationSocket } from "../../.agents/skills/verify-mcode/scripts/runtime.mjs";

export const THREAD_COUNT = 7;
const STOP_ONE_THREAD_COUNT = 6;
const STOP_ONE_ORDINAL = 3;
const TERMINAL_CONTROL_COUNT = 1;
export const WORKLOAD_MODEL = "gpt-5.6-luna";
const PROVIDER_ID = "codex";
const HEALTH_SAMPLE_INTERVAL_MS = 250;
const EVENT_LOOP_INTERVAL_MS = 50;
const TURN_TIMEOUT_MS = 120_000;
const CONTROL_RPC_TIMEOUT_MS = 90_000;
const CLEANUP_RPC_TIMEOUT_MS = 30_000;
const PERFORMANCE_DIRECTORY = [".dev", "verification", "performance", "seven-thread-live"];
const FIXTURE_SOURCE = [".agents", "skills", "verify-mcode", "scripts", "transcript-provider-fixture.mjs"];
const FIXTURE_PROMPT = "Seven concurrent performance verifier long narrative";
const FLAG_OPTIONS = new Set(["--run", "--confirm-run", "--confirm-cleanup", "--stop-one"]);
const VALUE_OPTIONS = new Set(["--label", "--cleanup", "--cleanup-receipt"]);
const TERMINAL_TRANSPORTS = new Map([
  ["legacy", {
    kind: "legacy",
    createMethod: "terminal.create",
    listMethod: "terminal.listActive",
    closeMethod: "terminal.kill",
  }],
  ["modern", {
    kind: "modern",
    createMethod: "terminal.session.create",
    listMethod: "terminal.session.list",
    closeMethod: "terminal.session.close",
  }],
]);

const HELP = `Seven concurrent thread live performance harness

Usage:
  bun scripts/perf/seven-thread-live-harness.mjs --run --confirm-run --label <before|after>
  bun scripts/perf/seven-thread-live-harness.mjs --run --confirm-run --label after --stop-one
  bun scripts/perf/seven-thread-live-harness.mjs --cleanup <receipt-path> --confirm-cleanup
  bun scripts/perf/seven-thread-live-harness.mjs --cleanup-receipt <receipt-path> --confirm-run

The run command creates exactly seven direct threads in this worktree's
.dev/fixture-repo. It temporarily routes Codex through the checked-in
transcript fixture and restores the previous setting during cleanup. It never
falls back to a real Codex model or prints runtime credentials.
--stop-one creates six fixture threads, stops the third while all six are
active, and verifies the other five complete and reload durably.
`;

/** Parses the small explicit command surface before any runtime mutation. */
export function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  const { flags, values } = scanArguments(argv);
  return selectHarnessCommand(flags, values);
}

function scanArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    assertLongOption(token);
    if (FLAG_OPTIONS.has(token)) {
      addUniqueOption(flags, token);
      flags.add(token);
      continue;
    }
    assertValueOption(token);
    const value = readOptionValue(argv, index, token);
    addUniqueOption(values, token);
    values.set(token, value);
    index += 1;
  }
  return { flags, values };
}

function assertLongOption(token) {
  if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
}

function addUniqueOption(options, token) {
  if (options.has(token)) throw new Error(`Duplicate option: ${token}`);
}

function assertValueOption(token) {
  if (!VALUE_OPTIONS.has(token)) throw new Error(`Unknown option: ${token}`);
}

function readOptionValue(argv, index, token) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
  return value;
}

function selectHarnessCommand(flags, values) {
  const wantsRun = flags.has("--run");
  const cleanupPath = values.get("--cleanup");
  const cleanupReceiptPath = values.get("--cleanup-receipt");
  assertSingleCleanupOption(cleanupPath, cleanupReceiptPath);
  const selectedCleanupPath = cleanupPath ?? cleanupReceiptPath;
  if (wantsRun === Boolean(selectedCleanupPath)) throw new Error("Choose exactly one of --run or cleanup receipt");
  if (wantsRun) return parseRunCommand(flags, values);
  if (cleanupReceiptPath) return parseCleanupReceiptCommand(flags, values, cleanupReceiptPath);
  return parseCleanupCommand(flags, values, cleanupPath);
}

function assertSingleCleanupOption(cleanupPath, cleanupReceiptPath) {
  if (cleanupPath && cleanupReceiptPath) throw new Error("Choose exactly one cleanup receipt option");
}

function parseRunCommand(flags, values) {
  if (!flags.has("--confirm-run")) throw new Error("--run requires --confirm-run");
  if (flags.has("--confirm-cleanup") || values.has("--cleanup") || values.has("--cleanup-receipt")) {
    throw new Error("--run cannot include cleanup options");
  }
  const label = values.get("--label");
  if (label !== "before" && label !== "after") throw new Error("--run requires --label before or --label after");
  return flags.has("--stop-one")
    ? { command: "run", label, stopOne: true }
    : { command: "run", label };
}

function parseCleanupReceiptCommand(flags, values, receiptPath) {
  if (!flags.has("--confirm-run") || flags.has("--confirm-cleanup") || flags.has("--stop-one") || values.has("--label")) {
    throw new Error("--cleanup-receipt requires --confirm-run and cannot include run options");
  }
  return { command: "cleanup", receiptPath };
}

function parseCleanupCommand(flags, values, receiptPath) {
  if (!flags.has("--confirm-cleanup")) throw new Error("--cleanup requires --confirm-cleanup");
  if (flags.has("--confirm-run") || flags.has("--stop-one") || values.has("--label")) throw new Error("--cleanup cannot include run options");
  return { command: "cleanup", receiptPath };
}

/** Uses a nearest-rank percentile so before and after receipts compare identically. */
export function summarizeLatency(samples) {
  const values = samples.filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const percentile = (fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  return {
    count: values.length,
    p50Ms: roundMs(percentile(0.5)),
    p95Ms: roundMs(percentile(0.95)),
    maxMs: roundMs(values.at(-1)),
  };
}

/** Audits delivery order from the public sequence assigned to each agent event. */
export function auditAgentEvents(events) {
  const audit = auditSequences(events.map((event) => event.sequence).filter(Number.isInteger), events.length);
  return {
    received: events.length,
    ...audit,
    completed: events.some((event) => event.type === "turnComplete"),
  };
}

function auditSequences(sequences, eventCount) {
  const seen = new Set();
  const duplicates = [];
  const arrivalOrderViolations = [];
  let previous = 0;
  for (const sequence of sequences) {
    if (seen.has(sequence)) duplicates.push(sequence);
    if (sequence <= previous) arrivalOrderViolations.push({ previous, sequence });
    seen.add(sequence);
    previous = sequence;
  }
  const largestSequence = largestSequenceIn(sequences);
  const missingSequences = missingSequenceNumbers(seen, largestSequence);
  return {
    firstSequence: firstSequenceIn(sequences),
    lastSequence: largestSequence || null,
    missingSequences,
    duplicateSequences: duplicates,
    arrivalOrderViolations,
    sequenceValid: sequencesAreValid(sequences, eventCount, missingSequences, duplicates, arrivalOrderViolations),
  };
}

function largestSequenceIn(sequences) {
  return sequences.length === 0 ? 0 : Math.max(...sequences);
}

function firstSequenceIn(sequences) {
  return sequences.length === 0 ? null : Math.min(...sequences);
}

function missingSequenceNumbers(seen, largestSequence) {
  const missingSequences = [];
  for (let sequence = 1; sequence <= largestSequence; sequence += 1) {
    if (!seen.has(sequence)) missingSequences.push(sequence);
  }
  return missingSequences;
}

function sequencesAreValid(sequences, eventCount, missingSequences, duplicates, arrivalOrderViolations) {
  return sequences.length === eventCount
    && missingSequences.length === 0
    && duplicates.length === 0
    && arrivalOrderViolations.length === 0;
}

/** Selects the exact Terminal lifecycle RPC family that the web transport selects. */
export function selectTerminalTransport(capabilities) {
  if (capabilities?.contractVersion === 1 && capabilities?.backend === "modern") {
    return terminalTransportForKind("modern");
  }
  if (capabilities?.contractVersion === 0 && capabilities?.backend === "legacy") {
    return terminalTransportForKind("legacy");
  }
  throw new Error("terminal.capabilities did not select a supported Terminal client");
}

function terminalTransportForKind(kind) {
  const transport = TERMINAL_TRANSPORTS.get(kind);
  return transport ? { ...transport } : null;
}

/** Normalizes the selected Terminal client's list response without changing its lifecycle RPCs. */
export function normalizeTerminalSessions(transport, sessions) {
  if (!Array.isArray(sessions)) throw new Error(`${transport.listMethod} did not return a list`);
  if (transport.kind === "legacy") {
    return sessions.map((session) => ({ ptyId: session?.ptyId, threadId: session?.threadId, state: "running" }));
  }
  return sessions.map((session) => ({
    ptyId: session?.sessionId,
    threadId: session?.scope?.kind === "thread" ? session.scope.threadId : session?.scope?.workspaceId,
    state: session?.state,
  }));
}

/** Extracts only Mcode server stall entries from JSONL server diagnostics. */
export function parseServerStallEntries(contents, startedAtMs, endedAtMs) {
  if (typeof contents !== "string") return [];
  const byTimestamp = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const sample = parseServerStallLine(line, startedAtMs, endedAtMs);
    if (!sample) continue;
    const previous = byTimestamp.get(sample.timestamp);
    if (!previous || sample.source === "server-work-stall") byTimestamp.set(sample.timestamp, sample);
  }
  return [...byTimestamp.values()].map(({ timestamp, stalledMs }) => ({ timestamp, stalledMs }));
}

function parseServerStallLine(line, startedAtMs, endedAtMs) {
  if (!line) return null;
  try {
    const entry = JSON.parse(line);
    const sample = serverStallSample(entry);
    if (!sample || !isValidServerStallTime(entry.timestamp, startedAtMs, endedAtMs)) return null;
    return { timestamp: entry.timestamp, ...sample };
  } catch {
    return null;
  }
}

function serverStallSample(entry) {
  if (entry?.kind === "server-work-stall" && entry.message === "Server work trace" && Number.isFinite(entry.delayMs)) {
    return { source: "server-work-stall", stalledMs: entry.delayMs };
  }
  if (entry?.message === "Event loop stalled" && Number.isFinite(entry.stalledMs)) {
    return { source: "event-loop-stalled", stalledMs: entry.stalledMs };
  }
  return null;
}

function isValidServerStallTime(timestamp, startedAtMs, endedAtMs) {
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= startedAtMs && timestampMs <= endedAtMs;
}

/** Creates the stable names used to prove that only this harness owns a thread. */
export function expectedThreadTitle(runId, ordinal, threadCount = THREAD_COUNT) {
  const name = threadCount === STOP_ONE_THREAD_COUNT ? "Six-thread Stop verification" : "Seven-thread live performance";
  return `${name} ${runId} ${ordinal}/${threadCount}`;
}

/** Runs the fixed seven-thread workload and writes its recovery-capable receipt. */
export async function runLiveHarness({ repoRoot = resolveRepoRoot(), label, stopOne = false }) {
  const context = createLiveHarnessContext(repoRoot, label, stopOne);
  startLiveHarness(context);
  try {
    await executeLiveHarness(context);
  } catch (error) {
    recordHarnessFailure(context, error);
  } finally {
    await finishLiveHarness(context);
  }
  if (context.primaryError) throw context.primaryError;
  return { receiptPath: context.run.receiptPath, receipt: context.receipt };
}

function createLiveHarnessContext(repoRoot, label, stopOne) {
  const paths = getRuntimePaths(repoRoot);
  const ports = requireLocalRuntime(repoRoot);
  const run = createRun(repoRoot, stopOne ? `${label}-stop-one` : label);
  const receipt = createReceipt(run, label, stopOne);
  const eventLoop = new EventLoopStallSampler(EVENT_LOOP_INTERVAL_MS);
  const serverStalls = new ServerLogStallReader(paths.logsDir);
  const healthSampler = new HealthSampler(ports.healthUrl, receipt.metrics.health);
  const eventState = new Map();
  const terminalEvents = new TerminalEventWaiter(eventState, stopOne);
  const turnStarts = new TurnStartWaiter(eventState);
  return {
    repoRoot,
    paths,
    ports,
    run,
    receipt,
    eventLoop,
    serverStalls,
    healthSampler,
    eventState,
    terminalEvents,
    turnStarts,
    socket: null,
    primaryError: null,
    workspace: null,
    stopOne,
  };
}

function startLiveHarness(context) {
  const { run, receipt, paths, eventLoop, serverStalls } = context;
  writeReceipt(run.receiptPath, receipt, paths.devDir);
  eventLoop.start();
  serverStalls.start();
}

async function executeLiveHarness(context) {
  await prepareLiveHarness(context);
  await configureFixture(context);
  await startWorkloadMeasurement(context);
  await createAndSubscribeThreads(context);
  const terminal = await preflightTerminalTransport(context);
  const { completed, sends } = await dispatchFixtureTurns(context);
  if (context.stopOne) await waitForAllSixActive(context);
  const stop = context.stopOne ? stopOneActiveTurn(context) : null;
  void stop?.catch(() => undefined);
  await sampleActiveControls(context, terminal);
  if (stop) await stop;
  throwFirstRejected(await sends, "Dispatching the controlled fixture turns failed");
  context.receipt.state.phase = "waiting-for-events";
  await completed;
  await readDurableConversations(context);
  await verifyCompletedWorkload(context);
}

async function prepareLiveHarness(context) {
  const { ports, receipt } = context;
  const initialHealth = await sampleHealth(ports.healthUrl);
  receipt.metrics.health.samples.push(initialHealth.durationMs);
  assertHealthyRuntime(initialHealth);
  context.socket = await openRuntimeVerificationSocket(context.repoRoot, (push) => capturePush(push, context.eventState, context.terminalEvents, context.turnStarts));
  await assertRuntimeIdle(context);
  await selectFixtureWorkspace(context);
}

function assertHealthyRuntime(health) {
  if (health.status !== "ok") throw new Error("The worktree runtime health endpoint did not return status=ok");
}

async function assertRuntimeIdle(context) {
  const activeAgents = await measuredRpc(context.socket, context.receipt.metrics.rpc, "agent.activeCount", {});
  const assertion = {
    phase: "before-dispatch",
    activeAgents,
    active: activeAgents > 0,
    observedAt: new Date().toISOString(),
  };
  context.receipt.state.activeTurnAssertions.push(assertion);
  if (assertion.active) throw new Error("The worktree runtime is busy; the harness will not change the Codex CLI setting while agents are active");
}

async function selectFixtureWorkspace(context) {
  const workspace = await requireFixtureWorkspace(context.socket, context.paths.fixtureRepoDir);
  context.workspace = workspace;
  context.receipt.workspace = { id: workspace.id, path: relativePath(context.repoRoot, context.paths.fixtureRepoDir) };
  context.receipt.state.phase = "fixture-setup";
  const settings = await measuredRpc(context.socket, context.receipt.metrics.rpc, "settings.get", {});
  context.receipt.state.originalCodexCli = settings?.provider?.cli?.codex ?? "";
}

async function configureFixture(context) {
  if (process.platform !== "win32") throw new Error("The controlled Codex fixture currently requires the Windows command wrapper");
  try {
    configureFixtureSetting(context);
    await updateFixtureSetting(context);
  } catch (error) {
    throw new Error(`The controlled Codex fixture could not be configured: ${safeError(error)}. No real Codex fallback was attempted; explicit approval is required before one can be used.`);
  }
  context.receipt.state.fixtureConfigured = true;
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
}

function configureFixtureSetting(context) {
  createFixtureWrapper(context.run.fixtureWrapperPath, context.repoRoot, context.paths.devDir);
  context.receipt.state.fixtureWrapper = relativePath(context.repoRoot, context.run.fixtureWrapperPath);
  context.receipt.state.fixtureSettingMayBeChanged = true;
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
}

async function updateFixtureSetting(context) {
  await measuredRpc(context.socket, context.receipt.metrics.rpc, "settings.update", {
    provider: { cli: { codex: context.run.fixtureWrapperPath } },
  });
}

async function startWorkloadMeasurement(context) {
  context.healthSampler.start();
  context.receipt.metrics.memory.push(await readMemorySnapshot(context.paths));
}

async function createAndSubscribeThreads(context) {
  const branch = currentFixtureBranch(context.paths.fixtureRepoDir);
  context.receipt.state.phase = "creating-threads";
  const creations = await Promise.allSettled(Array.from({ length: context.receipt.workload.threadCount }, (_, index) => createOwnedThread(context, branch, index + 1)));
  throwFirstRejected(creations, "Creating verifier-owned direct threads failed");
  assertCreatedThreadCount(context.receipt);
  await subscribeToThreadEvents(context);
}

async function createOwnedThread(context, branch, ordinal) {
  const title = expectedThreadTitle(context.run.id, ordinal, context.receipt.workload.threadCount);
  const thread = await measuredRpc(context.socket, context.receipt.metrics.rpc, "thread.create", {
    workspaceId: context.workspace.id,
    title,
    mode: "direct",
    branch,
  });
  const record = { id: thread?.id, title, ordinal, events: [], ptyId: null, sentAtMs: null, startedAtMs: null, completedAtMs: null, persistedAtMs: null, durable: null };
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error(`Thread ${ordinal} did not return an ID`);
  context.receipt.state.threads.push(record);
  context.eventState.set(record.id, record);
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
  return record;
}

function assertCreatedThreadCount(receipt) {
  if (receipt.state.threads.length !== receipt.workload.threadCount) throw new Error("The harness did not create the requested fixture thread count");
}

async function subscribeToThreadEvents(context) {
  const threadIds = context.receipt.state.threads.map((thread) => thread.id);
  await measuredRpc(context.socket, context.receipt.metrics.rpc, "push.setThreadSubscriptions", {
    threadIds,
    cursors: Object.fromEntries(threadIds.map((threadId) => [threadId, 0])),
  });
}

async function preflightTerminalTransport(context) {
  context.receipt.state.phase = "preflighting-terminal-transport";
  const capabilities = await measuredRpc(context.socket, context.receipt.metrics.rpc, "terminal.capabilities", {}, "terminal.capabilities.preflight", CONTROL_RPC_TIMEOUT_MS);
  const transport = selectTerminalTransport(capabilities);
  context.receipt.state.terminalTransport = transport;
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
  return { capabilities, transport };
}

async function dispatchFixtureTurns(context) {
  const completed = context.terminalEvents.wait(TURN_TIMEOUT_MS);
  void completed.catch(() => undefined);
  const started = context.turnStarts.wait(TURN_TIMEOUT_MS);
  context.receipt.state.phase = "sending-turns";
  const sends = Promise.allSettled(context.receipt.state.threads.map((thread) => sendFixtureTurn(context, thread)));
  await started;
  return { completed, sends };
}

async function waitForAllSixActive(context) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const threads = context.receipt.state.threads;
  while (Date.now() < deadline) {
    if (threads.some((thread) => thread.completedAtMs !== null || thread.persistedAtMs !== null)) {
      throw new Error("A fixture turn ended before all six became active; Stop proof is inconclusive");
    }
    const target = threads[STOP_ONE_ORDINAL - 1];
    if (threads.every((thread) => thread.startedAtMs !== null)
      && target.events.filter((event) => event.type === "assistantMessageBoundary").length >= 10) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("All six fixture turns and ten narrative boundaries in the stopped turn were not observed before the deadline");
}

async function stopOneActiveTurn(context) {
  const target = context.receipt.state.threads[STOP_ONE_ORDINAL - 1];
  const launchedAtMs = NodePerfHooks.performance.now();
  const allSixActiveAtLaunch = context.receipt.state.threads.every(isActiveFixtureThread);
  if (!allSixActiveAtLaunch) throw new Error("Stop did not launch while all six fixture turns were active");
  context.receipt.state.stop = { ordinal: STOP_ONE_ORDINAL, threadId: target.id, launchedAtMs, allSixActiveAtLaunch };
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
  const result = await measuredRpc(context.socket, context.receipt.metrics.rpc, "agent.stop", { threadId: target.id }, undefined, CONTROL_RPC_TIMEOUT_MS);
  context.receipt.state.stop = {
    ...context.receipt.state.stop,
    completedAtMs: NodePerfHooks.performance.now(),
    status: result?.status,
    dispatchState: result?.dispatchState,
    turnExecutionId: result?.turnExecutionId,
    snapshotPhase: result?.snapshot?.phase,
  };
  if (!isCancelledStopResult(result, target.id)) {
    throw new Error("Stop did not return the targeted execution's cancelled outcome");
  }
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
}

function isActiveFixtureThread(thread) {
  return thread.startedAtMs !== null && thread.completedAtMs === null && thread.persistedAtMs === null;
}

function isCancelledStopResult(result, threadId) {
  return result?.status === "cancelled" && result?.snapshot?.phase === "cancelled" && result?.threadId === threadId;
}

async function sendFixtureTurn(context, thread) {
  thread.sentAtMs = NodePerfHooks.performance.now();
  await measuredRpc(context.socket, context.receipt.metrics.rpc, "agent.send", {
    threadId: thread.id,
    content: FIXTURE_PROMPT,
    messageId: NodeCrypto.randomUUID(),
    provider: PROVIDER_ID,
    model: WORKLOAD_MODEL,
    permissionMode: "full",
  });
}

async function sampleActiveControls(context, terminal) {
  context.receipt.state.phase = "sampling-active-controls";
  const controlLaunch = createControlLaunch(context.receipt.state.threads);
  context.receipt.state.activeControlLaunch = controlLaunch;
  context.receipt.state.terminalCreateInconclusive = controlLaunch.inconclusive;
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
  const requests = launchActiveControlRequests({
    socket: context.socket,
    metrics: context.receipt.metrics.rpc,
    workspaceId: context.workspace.id,
    terminalTransport: terminal.transport,
    threads: context.receipt.state.threads.slice(0, TERMINAL_CONTROL_COUNT),
    persistTerminal: (thread, created) => persistCreatedTerminal(context, thread, created),
  });
  const results = await Promise.allSettled(requests.map((request) => request.promise));
  throwFirstRejected(results, "Sampling active controls and creating verifier-owned terminal PTYs failed");
  recordControlResults(context.receipt, results, terminal, controlLaunch);
  assertTerminalCreated(context.receipt);
}

function persistCreatedTerminal(context, thread, terminal) {
  if (typeof terminal?.ptyId !== "string" || terminal.ptyId.length === 0) throw new Error(`Terminal create did not return a PTY for thread ${thread.ordinal}`);
  thread.ptyId = terminal.ptyId;
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
}

function recordControlResults(receipt, results, terminal, controlLaunch) {
  const models = results[0].value;
  const activeCapabilities = results[1].value;
  const activeTransport = selectTerminalTransport(activeCapabilities);
  assertMatchingTerminalTransport(activeTransport, terminal.transport);
  receipt.modelList = { ...summarizeModelList(models), activeTurnAssertion: controlLaunch, inconclusive: controlLaunch.inconclusive };
  receipt.terminalCapabilities = {
    ...summarizeTerminalCapabilities(activeCapabilities, activeTransport),
    preflight: summarizeTerminalCapabilities(terminal.capabilities, terminal.transport),
    activeTurnAssertion: controlLaunch,
    inconclusive: controlLaunch.inconclusive,
  };
}

function assertMatchingTerminalTransport(activeTransport, preflightTransport) {
  if (activeTransport.kind !== preflightTransport.kind) throw new Error("terminal.capabilities selected a different Terminal client after dispatch");
}

function assertTerminalCreated(receipt) {
  if (receipt.state.threads.slice(0, TERMINAL_CONTROL_COUNT).some((thread) => typeof thread.ptyId !== "string")) {
    throw new Error("The harness did not create the user terminal during the seven active turns");
  }
}

async function readDurableConversations(context) {
  context.receipt.state.phase = "reading-durable-conversations";
  const reads = await Promise.allSettled(context.receipt.state.threads.map((thread) => readDurableConversation(context, thread)));
  throwFirstRejected(reads, "Reading durable conversation tails failed");
  context.receipt.metrics.memory.push(await readMemorySnapshot(context.paths));
}

async function readDurableConversation(context, thread) {
  const tail = await measuredRpc(context.socket, context.receipt.metrics.rpc, "conversation.tail", { threadId: thread.id, limit: 2 });
  const expectedOutcome = context.stopOne && thread.ordinal === STOP_ONE_ORDINAL ? "cancelled" : "completed";
  const assistant = tail?.messages?.find((message) => message?.role === "assistant");
  const narrative = expectedOutcome === "cancelled" && assistant
    ? await measuredRpc(context.socket, context.receipt.metrics.rpc, "narrative.list", { messageId: assistant.id })
    : null;
  thread.durable = context.stopOne
    ? auditConversationOutcome(tail, narrative, expectedOutcome, context.receipt.state.stop?.turnExecutionId)
    : auditConversationTail(tail);
  if (!thread.durable.ok) throw new Error(`Durable conversation proof failed for thread ${thread.ordinal}`);
}

async function verifyCompletedWorkload(context) {
  const activeAgents = await measuredRpc(context.socket, context.receipt.metrics.rpc, "agent.activeCount", {});
  if (activeAgents !== 0) throw new Error("The controlled turns completed but the runtime still reports active agents");
  if (context.stopOne) await verifyStoppedRuntimeSnapshot(context);
  assertConclusiveControlSamples(context.receipt);
  if (!auditRun(context.receipt)) throw new Error("The controlled workload completed with event-loss, order, completion, or durability failures");
}

async function verifyStoppedRuntimeSnapshot(context) {
  const snapshots = await measuredRpc(context.socket, context.receipt.metrics.rpc, "agent.listRunning", {});
  const stop = context.receipt.state.stop;
  stop.reconnectSnapshot = Array.isArray(snapshots) && snapshots.some((snapshot) =>
    snapshot?.threadId === stop.threadId
    && snapshot?.turnExecutionId === stop.turnExecutionId
    && snapshot?.phase === "cancelled");
  if (!stop.reconnectSnapshot) throw new Error("The stopped execution did not retain its cancelled reconnect snapshot");
}

function assertConclusiveControlSamples(receipt) {
  if (receipt.modelList?.inconclusive || receipt.terminalCapabilities?.inconclusive || receipt.state.terminalCreateInconclusive) {
    throw new Error("The active-turn control samples were inconclusive because all fixture turns finished before a required RPC could begin");
  }
}

function recordHarnessFailure(context, error) {
  context.primaryError = error instanceof Error ? error : new Error(String(error));
  context.receipt.failure = safeError(context.primaryError);
}

async function finishLiveHarness(context) {
  await context.healthSampler.stop();
  context.eventLoop.stop();
  await cleanUpLiveHarness(context);
  await recordFinalReceiptMetrics(context);
  writeReceipt(context.run.receiptPath, context.receipt, context.paths.devDir);
  await closeLiveHarnessSocket(context.socket);
}

async function cleanUpLiveHarness(context) {
  if (!context.socket) return;
  const cleanup = await cleanupOwnedResources(context.socket, context.receipt, context.paths, context.repoRoot);
  context.receipt.cleanup = cleanup;
  if (!cleanup.ok && !context.primaryError) {
    context.primaryError = new Error("The workload completed but owned-resource cleanup was incomplete");
  }
}

async function recordFinalReceiptMetrics(context) {
  const { receipt, eventLoop, serverStalls, paths } = context;
  receipt.metrics.memory.push(await readMemorySnapshot(paths));
  receipt.metrics.health.summary = summarizeLatency(receipt.metrics.health.samples);
  receipt.metrics.rpc = Object.fromEntries(Object.entries(receipt.metrics.rpc).map(([method, samples]) => [method, summarizeLatency(samples)]));
  receipt.metrics.turnCompletion = summarizeLatency(receipt.state.threads.map((thread) => elapsedSinceSend(thread, "completedAtMs")));
  receipt.metrics.turnDurability = summarizeLatency(receipt.state.threads.map((thread) => elapsedSinceSend(thread, "persistedAtMs")));
  receipt.state.activeControlLaunch = attributeControlLaunchToTurnCompletion(receipt.state.activeControlLaunch, receipt.state.threads);
  receipt.metrics.events = summarizeEventAudits(receipt.state.threads);
  receipt.metrics.harnessEventLoopStalls = {
    scope: "harness-process",
    intervalMs: EVENT_LOOP_INTERVAL_MS,
    summary: eventLoop.summary(),
  };
  receipt.metrics.serverEventLoopStalls = serverStalls.collect();
  receipt.metrics.memorySummary = summarizeMemory(receipt.metrics.memory);
  receipt.completedAt = new Date().toISOString();
  receipt.state.phase = context.primaryError ? "failed" : "complete";
  receipt.ok = context.primaryError === null && receipt.cleanup?.ok === true && receipt.metrics.events.ok;
  clearRestoredFixtureSetting(receipt);
}

function clearRestoredFixtureSetting(receipt) {
  if (receipt.cleanup?.settingsRestored === true) {
    delete receipt.state.originalCodexCli;
    receipt.state.fixtureSettingMayBeChanged = false;
  }
}

async function closeLiveHarnessSocket(socket) {
  if (socket) await socket.close().catch(() => undefined);
}

/** Cleans a stopped or interrupted receipt without creating a new workload. */
export async function cleanupReceipt({ repoRoot = resolveRepoRoot(), receiptPath }) {
  const paths = getRuntimePaths(repoRoot);
  const resolvedReceipt = resolveReceiptPath(repoRoot, receiptPath, paths.devDir);
  const receipt = readReceipt(resolvedReceipt, paths.devDir);
  const socket = await openRuntimeVerificationSocket(repoRoot);
  try {
    receipt.cleanup = await cleanupOwnedResources(socket, receipt, paths, repoRoot);
    receipt.completedAt ??= new Date().toISOString();
    receipt.state.phase = receipt.cleanup.ok ? "cleaned" : "cleanup-failed";
    if (receipt.cleanup.settingsRestored === true) {
      delete receipt.state.originalCodexCli;
      receipt.state.fixtureSettingMayBeChanged = false;
    }
    writeReceipt(resolvedReceipt, receipt, paths.devDir);
  } finally {
    await socket.close().catch(() => undefined);
  }
  if (!receipt.cleanup.ok) throw new Error("Owned-resource cleanup was incomplete; inspect the receipt before retrying");
  return { receiptPath: resolvedReceipt, receipt };
}

function createRun(repoRoot, label) {
  const paths = getRuntimePaths(repoRoot);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomUUID()}`;
  const directory = NodePath.join(repoRoot, ...PERFORMANCE_DIRECTORY, `${label}-${id}`);
  assertInsideDevDir(directory, paths.devDir);
  ensureRealDirectory(directory, paths.devDir);
  return {
    id,
    directory,
    receiptPath: NodePath.join(directory, "receipt.json"),
    fixtureWrapperPath: NodePath.join(directory, "codex-transcript-fixture.cmd"),
  };
}

function createReceipt(run, label, stopOne) {
  return {
    schemaVersion: 1,
    runId: run.id,
    label,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ok: false,
    workload: {
      threadCount: stopOne ? STOP_ONE_THREAD_COUNT : THREAD_COUNT,
      scenario: stopOne ? "stop-one" : "baseline",
      terminalControlCount: TERMINAL_CONTROL_COUNT,
      provider: PROVIDER_ID,
      model: WORKLOAD_MODEL,
      fixture: ".agents/skills/verify-mcode/scripts/transcript-provider-fixture.mjs",
      prompt: FIXTURE_PROMPT,
      controlRpcTimeoutMs: CONTROL_RPC_TIMEOUT_MS,
      upstreamProviderCalls: false,
    },
    workspace: null,
    modelList: null,
    terminalCapabilities: null,
    state: {
      phase: "created",
      fixtureConfigured: false,
      fixtureSettingMayBeChanged: false,
      fixtureWrapper: null,
      originalCodexCli: null,
      terminalTransport: null,
      activeTurnAssertions: [],
      activeControlLaunch: null,
      terminalCreateInconclusive: false,
      stop: null,
      threads: [],
    },
    metrics: {
      health: { samples: [], summary: null },
      rpc: {},
      turnCompletion: null,
      turnDurability: null,
      events: null,
      harnessEventLoopStalls: null,
      serverEventLoopStalls: null,
      memory: [],
      memorySummary: null,
    },
    cleanup: null,
    failure: null,
  };
}

function requireLocalRuntime(repoRoot) {
  const ports = readPortsFile(repoRoot);
  if (!ports) throw new Error("The worktree runtime contract is missing; start this worktree runtime before running the harness");
  if (!samePath(ports.worktreeIdentity, repoRoot)) throw new Error("The runtime contract belongs to a different worktree");
  return ports;
}

async function requireFixtureWorkspace(socket, fixtureRepoDir, deadline) {
  assertRuntimeDirectorySafe(fixtureRepoDir, "fixture repository");
  const fixtureRealPath = NodeFS.realpathSync.native(fixtureRepoDir);
  const workspaces = await socket.rpc("workspace.list", {}, deadline);
  const matches = Array.isArray(workspaces) ? workspaces.filter((workspace) => {
    if (!workspace || typeof workspace.id !== "string" || typeof workspace.path !== "string") return false;
    try { return samePath(NodeFS.realpathSync.native(workspace.path), fixtureRealPath); } catch { return false; }
  }) : [];
  if (matches.length !== 1) throw new Error("The worktree fixture repository must be registered exactly once before the harness runs");
  return matches[0];
}

function createFixtureWrapper(wrapperPath, repoRoot, devDir) {
  const fixtureSource = NodePath.join(repoRoot, ...FIXTURE_SOURCE);
  if (!NodeFS.existsSync(fixtureSource)) throw new Error("The controlled Codex transcript fixture is missing");
  assertInsideDevDir(wrapperPath, devDir);
  if (NodeFS.existsSync(wrapperPath)) throw new Error("The new run already has a fixture wrapper");
  const contents = renderFixtureWrapper(process.execPath, fixtureSource);
  const descriptor = NodeFS.openSync(wrapperPath, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, contents, "utf8");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function currentFixtureBranch(fixtureRepoDir) {
  const branch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], {
    cwd: fixtureRepoDir,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!branch) throw new Error("The fixture repository has no checked-out branch");
  return branch;
}

async function createTerminal(socket, metrics, transport, workspaceId, threadId, timeoutMs) {
  if (transport.kind === "legacy") {
    return await measuredRpc(socket, metrics, transport.createMethod, { threadId }, undefined, timeoutMs);
  }
  const session = await measuredRpc(socket, metrics, transport.createMethod, {
    scope: { kind: "thread", workspaceId, threadId },
  }, undefined, timeoutMs);
  return {
    ptyId: session?.sessionId,
    shell: session?.launch?.resolvedProfile?.executable,
  };
}

/** Starts active control requests without awaiting one request before the next. */
export function launchActiveControlRequests({ socket, metrics, workspaceId, terminalTransport, threads, persistTerminal }) {
  const requests = [
    {
      kind: "model-list",
      promise: measuredRpc(socket, metrics, "provider.listModels", { providerId: PROVIDER_ID }, undefined, CONTROL_RPC_TIMEOUT_MS),
    },
    {
      kind: "terminal-capabilities",
      promise: measuredRpc(socket, metrics, "terminal.capabilities", {}, undefined, CONTROL_RPC_TIMEOUT_MS),
    },
  ];
  for (const thread of threads) {
    requests.push({
      kind: "terminal-create",
      threadId: thread.id,
      promise: createTerminal(socket, metrics, terminalTransport, workspaceId, thread.id, CONTROL_RPC_TIMEOUT_MS).then((terminal) => {
        persistTerminal(thread, terminal);
        return terminal;
      }),
    });
  }
  return requests;
}

function terminalTransportFromReceipt(receipt) {
  const transport = receipt?.state?.terminalTransport;
  if (!transport || typeof transport !== "object") throw new Error("The cleanup receipt has no selected Terminal transport");
  const expected = terminalTransportForKind(transport.kind);
  if (matchesTerminalTransport(transport, expected)) return transport;
  throw new Error("The cleanup receipt has an invalid Terminal transport");
}

function matchesTerminalTransport(transport, expected) {
  return expected !== null
    && transport.kind === expected.kind
    && transport.createMethod === expected.createMethod
    && transport.listMethod === expected.listMethod
    && transport.closeMethod === expected.closeMethod;
}

async function measuredRpc(socket, metrics, method, params, metricName = method, timeoutMs) {
  const started = NodePerfHooks.performance.now();
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : undefined;
  const result = await socket.rpc(method, params, deadline);
  recordMetric(metrics, metricName, NodePerfHooks.performance.now() - started);
  return result;
}

function recordMetric(metrics, name, durationMs) {
  const samples = metrics[name] ?? [];
  samples.push(durationMs);
  metrics[name] = samples;
}

function capturePush(push, state, terminalEvents, turnStarts) {
  const thread = threadForPush(push, state);
  if (!thread) return;
  recordThreadPush(push, thread, turnStarts);
  terminalEvents.notify();
}

function threadForPush(push, state) {
  if (push?.type !== "push") return null;
  const data = push.data;
  if (!data || typeof data !== "object" || typeof data.threadId !== "string") return null;
  return state.get(data.threadId) ?? null;
}

function recordThreadPush(push, thread, turnStarts) {
  const now = NodePerfHooks.performance.now();
  if (push.channel === "agent.event") {
    recordAgentEvent(push.data, thread, now, turnStarts);
  } else if (push.channel === "turn.persisted") {
    thread.persistedAtMs ??= now;
    thread.persistedOutcome ??= push.data.outcome ?? null;
  } else if (push.channel === "thread.status") {
    thread.status = push.data.status;
  }
}

function recordAgentEvent(event, thread, now, turnStarts) {
  thread.events.push({ sequence: event.sequence, type: event.type, atMs: now });
  if (event.type === "turnStarted") {
      thread.startedAtMs ??= now;
      turnStarts.notify();
  }
  if (event.type === "turnComplete") thread.completedAtMs ??= now;
}

/** Records whether public turn events still show work in flight when controls launch. */
export function createControlLaunch(threads, launchedAtMs = NodePerfHooks.performance.now()) {
  const activeThreadOrdinals = threads
    .filter((thread) => Number.isFinite(thread.startedAtMs)
      && thread.startedAtMs <= launchedAtMs
      && (!Number.isFinite(thread.completedAtMs) || thread.completedAtMs > launchedAtMs))
    .map((thread) => thread.ordinal);
  return {
    triggeredBy: "first-turnStarted",
    launchedAtMs,
    observedActiveThreadOrdinals: activeThreadOrdinals,
    completedThreadOrdinalsAtLaunch: threads
      .filter((thread) => Number.isFinite(thread.completedAtMs) && thread.completedAtMs <= launchedAtMs)
      .map((thread) => thread.ordinal),
    inconclusive: activeThreadOrdinals.length === 0,
    observedAt: new Date().toISOString(),
  };
}

/** Relates control launch to every observed turn completion for the receipt. */
export function attributeControlLaunchToTurnCompletion(controlLaunch, threads) {
  if (!controlLaunch || !Number.isFinite(controlLaunch.launchedAtMs)) return null;
  const completionAfterLaunchMs = threads.map((thread) => ({
    ordinal: thread.ordinal,
    elapsedMs: Number.isFinite(thread.completedAtMs) ? roundMs(thread.completedAtMs - controlLaunch.launchedAtMs) : null,
  }));
  const completedAfterLaunch = completionAfterLaunchMs
    .map((entry) => entry.elapsedMs)
    .filter((elapsedMs) => Number.isFinite(elapsedMs) && elapsedMs >= 0);
  return {
    ...controlLaunch,
    completionAfterLaunchMs,
    firstTurnCompletionAfterLaunchMs: completedAfterLaunch.length === 0 ? null : Math.min(...completedAfterLaunch),
    lastTurnCompletionAfterLaunchMs: completedAfterLaunch.length === 0 ? null : Math.max(...completedAfterLaunch),
  };
}

class TerminalEventWaiter {
  constructor(state, stopOne = false) {
    this.state = state;
    this.stopOne = stopOne;
    this.resolve = null;
  }

  wait(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolve = null;
        reject(new Error("Not every controlled thread produced both turn completion and durable persistence events before the deadline"));
      }, timeoutMs);
      this.resolve = () => {
        if (![...this.state.values()].every((thread) =>
          this.stopOne && thread.ordinal === STOP_ONE_ORDINAL
            ? thread.status === "paused" || thread.status === "cancelled"
            : thread.persistedAtMs !== null && thread.completedAtMs !== null)) return;
        this.resolve = null;
        clearTimeout(timer);
        resolve();
      };
      this.resolve();
    });
  }

  notify() {
    this.resolve?.();
  }
}

class TurnStartWaiter {
  constructor(state) {
    this.state = state;
    this.resolve = null;
  }

  wait(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolve = null;
        reject(new Error("No controlled fixture turn started before the deadline"));
      }, timeoutMs);
      this.resolve = () => {
        if (![...this.state.values()].every((thread) => thread.startedAtMs !== null)) return;
        this.resolve = null;
        clearTimeout(timer);
        resolve();
      };
      this.resolve();
    });
  }

  notify() {
    this.resolve?.();
  }
}

function auditConversationTail(tail) {
  const messages = Array.isArray(tail?.messages) ? tail.messages : [];
  const roles = new Set(messages.map((message) => message?.role));
  const assistant = messages.find((message) => message?.role === "assistant");
  return {
    messageCount: messages.length,
    hasUserMessage: roles.has("user"),
    hasFixtureAssistantMessage: typeof assistant?.content === "string" && assistant.content.includes("Fixture answer:"),
    ok: roles.has("user") && typeof assistant?.content === "string" && assistant.content.includes("Fixture answer:"),
  };
}

function auditConversationOutcome(tail, narrative, expectedOutcome, expectedExecutionId) {
  const messages = Array.isArray(tail?.messages) ? tail.messages : [];
  const assistant = messages.find((message) => message?.role === "assistant");
  const hasUserMessage = messages.some((message) => message?.role === "user");
  const assistantSummary = summarizeAssistantOutcome(assistant);
  const narrativeSummary = summarizeNarrativeOutcome(narrative);
  const summary = { messageCount: messages.length, hasUserMessage, ...assistantSummary, ...narrativeSummary };
  return {
    ...summary,
    ok: hasExpectedDurableOutcome(summary, expectedOutcome, expectedExecutionId),
  };
}

function summarizeAssistantOutcome(assistant) {
  return {
    hasFixtureAssistantMessage: assistant?.content?.includes("Fixture answer:") === true,
    assistantContentLength: assistant?.content?.length ?? 0,
    outcome: assistant?.outcome ?? null,
    outcomeExecutionId: assistant?.outcomeExecutionId ?? null,
  };
}

function summarizeNarrativeOutcome(narrative) {
  const thoughts = narrative?.thoughts ?? [];
  const tools = narrative?.tools ?? [];
  return {
    hasRetainedNarrative: thoughts.some((segment) => segment.text?.includes("Fixture step 1:")),
    thoughtSegmentCount: thoughts.length,
    toolCount: tools.length,
  };
}

function hasExpectedDurableOutcome(summary, expectedOutcome, expectedExecutionId) {
  if (!summary.hasUserMessage || summary.outcome !== expectedOutcome) return false;
  if (expectedOutcome !== "cancelled") return summary.hasFixtureAssistantMessage;
  return summary.outcomeExecutionId === expectedExecutionId
    && summary.hasRetainedNarrative
    && !summary.hasFixtureAssistantMessage;
}

function auditRun(receipt) {
  return receipt.state.threads.every((thread) => {
    thread.eventAudit = auditAgentEvents(thread.events);
    return thread.eventAudit.sequenceValid && isExpectedTerminal(receipt, thread) && thread.durable?.ok === true;
  });
}

function isExpectedTerminal(receipt, thread) {
  if (receipt.workload.scenario !== "stop-one" || thread.ordinal !== STOP_ONE_ORDINAL) return thread.eventAudit.completed;
  return receipt.state.stop?.status === "cancelled"
    && receipt.state.stop?.reconnectSnapshot === true
    && (thread.status === "paused" || thread.status === "cancelled");
}

function summarizeEventAudits(threads) {
  const audits = threads.map((thread) => thread.eventAudit ?? auditAgentEvents(thread.events ?? []));
  for (let index = 0; index < threads.length; index += 1) threads[index].eventAudit = audits[index];
  const flatten = (field) => audits.flatMap((audit) => audit[field] ?? []);
  return {
    threadCount: audits.length,
    completedThreads: audits.filter((audit) => audit.completed).length,
    received: audits.reduce((total, audit) => total + audit.received, 0),
    missingSequences: flatten("missingSequences"),
    duplicateSequences: flatten("duplicateSequences"),
    arrivalOrderViolations: flatten("arrivalOrderViolations"),
    ok: audits.length === threads.length && audits.every((audit) => audit.sequenceValid)
      && threads.every((thread) => thread.durable?.ok === true)
      && threads.every((thread) => hasExpectedEventTerminal(thread, threads.length)),
  };
}

function hasExpectedEventTerminal(thread, threadCount) {
  if (threadCount !== STOP_ONE_THREAD_COUNT || thread.ordinal !== STOP_ONE_ORDINAL) return thread.eventAudit.completed;
  return thread.status === "paused" || thread.status === "cancelled";
}

async function cleanupOwnedResources(socket, receipt, paths, repoRoot) {
  const cleanup = { ok: true, ptys: [], threads: [], settingsRestored: false, wrapperRemoved: false, failures: [] };
  const threads = Array.isArray(receipt?.state?.threads) ? receipt.state.threads : [];
  const workspace = await verifyCleanupWorkspace(socket, receipt, paths, cleanup);
  const terminalTransport = resolveCleanupTransport(receipt, threads, cleanup);
  await cleanupWorkloadResources(socket, receipt, threads, workspace, terminalTransport, cleanup);
  await restoreFixtureSetting(socket, receipt, cleanup);
  removeFixtureWrapper(receipt, repoRoot, paths.devDir, cleanup);
  cleanup.ok = cleanup.failures.length === 0;
  return cleanup;
}

async function verifyCleanupWorkspace(socket, receipt, paths, cleanup) {
  try {
    const fixture = await requireFixtureWorkspace(socket, paths.fixtureRepoDir, cleanupDeadline());
    const workspace = receipt?.workspace;
    if (!workspace || fixture.id !== workspace.id) throw new Error("The cleanup receipt does not belong to this worktree fixture workspace");
    return workspace;
  } catch (error) {
    cleanup.failures.push(safeError(error));
    return null;
  }
}

function resolveCleanupTransport(receipt, threads, cleanup) {
  if (threads.length === 0 || !receipt?.state?.terminalTransport) return null;
  try {
    return terminalTransportFromReceipt(receipt);
  } catch (error) {
    cleanup.failures.push(safeError(error));
    return null;
  }
}

async function cleanupWorkloadResources(socket, receipt, threads, workspace, terminalTransport, cleanup) {
  if (cleanup.failures.length > 0) return;
  if (terminalTransport) await cleanupPtys(socket, threads, terminalTransport, cleanup);
  await cleanupThreads(socket, threads, workspace.id, receipt.runId, receipt.workload.threadCount, cleanup);
}

async function cleanupPtys(socket, threads, transport, cleanup) {
  const active = await activeTerminalSessions(socket, transport, cleanup);
  if (active === null) return;
  for (const thread of threads) {
    await cleanupThreadPtys(socket, transport, active, thread, cleanup);
  }
  await verifyPtysRemoved(socket, transport, threads, cleanup);
}

async function activeTerminalSessions(socket, transport, cleanup) {
  try {
    return normalizeTerminalSessions(transport, await cleanupRpc(socket, transport.listMethod, {}));
  } catch (error) {
    cleanup.failures.push(`${transport.listMethod}: ${safeError(error)}`);
    return null;
  }
}

async function cleanupThreadPtys(socket, transport, active, thread, cleanup) {
  if (typeof thread?.id !== "string") return;
  const ownedPtys = active.filter((pty) => pty?.threadId === thread.id);
  if (ownedPtys.length === 0) {
    recordAlreadyClosedPty(thread, cleanup);
    return;
  }
  for (const current of ownedPtys) {
    await cleanupPty(socket, transport, current, thread, cleanup);
  }
}

function recordAlreadyClosedPty(thread, cleanup) {
  if (typeof thread.ptyId === "string") cleanup.ptys.push({ ptyId: thread.ptyId, outcome: "already-closed" });
}

async function cleanupPty(socket, transport, current, thread, cleanup) {
  if (typeof current.ptyId !== "string") {
    cleanup.failures.push(`Refusing to kill a PTY with no ID for verifier thread ${thread.id}`);
    return;
  }
  thread.ptyId ??= current.ptyId;
  if (current.state === "exited" || current.state === "failed") {
    cleanup.ptys.push({ ptyId: current.ptyId, outcome: "already-closed" });
    return;
  }
  try {
    await closeTerminal(socket, transport, current.ptyId);
    cleanup.ptys.push({ ptyId: current.ptyId, outcome: "killed" });
  } catch (error) {
    cleanup.failures.push(`${transport.closeMethod} ${current.ptyId}: ${safeError(error)}`);
  }
}

async function verifyPtysRemoved(socket, transport, threads, cleanup) {
  try {
    const remaining = normalizeTerminalSessions(transport, await cleanupRpc(socket, transport.listMethod, {}));
    if (!Array.isArray(remaining)) throw new Error("terminal.listActive did not return a list");
    for (const thread of threads) {
      if (hasRunningPty(remaining, thread)) {
        cleanup.failures.push(`An owned PTY remains active for verifier thread ${thread.id} after cleanup`);
      }
    }
  } catch (error) {
    cleanup.failures.push(`${transport.listMethod} after cleanup: ${safeError(error)}`);
  }
}

function hasRunningPty(ptys, thread) {
  if (typeof thread?.id !== "string") return false;
  return ptys.some((pty) => pty?.threadId === thread.id && pty.state === "running");
}

async function closeTerminal(socket, transport, ptyId) {
  if (transport.kind === "legacy") {
    await cleanupRpc(socket, transport.closeMethod, { ptyId });
    return;
  }
  await cleanupRpc(socket, transport.closeMethod, { sessionId: ptyId, reason: "user" });
}

function cleanupDeadline() {
  return Date.now() + CLEANUP_RPC_TIMEOUT_MS;
}

function cleanupRpc(socket, method, params) {
  return socket.rpc(method, params, cleanupDeadline());
}

async function cleanupThreads(socket, threads, workspaceId, runId, threadCount, cleanup) {
  const current = await currentWorkspaceThreads(socket, workspaceId, cleanup);
  if (current === null) return;
  for (const thread of threads) {
    await cleanupThread(socket, current, thread, runId, threadCount, cleanup);
  }
  await verifyThreadsRemoved(socket, threads, workspaceId, cleanup);
}

async function currentWorkspaceThreads(socket, workspaceId, cleanup) {
  try {
    return await cleanupRpc(socket, "thread.list", { workspaceId });
  } catch (error) {
    cleanup.failures.push(`thread.list: ${safeError(error)}`);
    return null;
  }
}

async function cleanupThread(socket, current, thread, runId, threadCount, cleanup) {
  if (!isReceiptThread(thread)) return;
  const found = current.find((candidate) => candidate?.id === thread.id);
  if (!found) {
    cleanup.threads.push({ threadId: thread.id, outcome: "already-deleted" });
    return;
  }
  if (!matchesReceiptThread(found, thread, runId, threadCount)) {
    cleanup.failures.push(`Refusing to delete thread ${thread.id}: title does not match this receipt`);
    return;
  }
  try {
    const deleted = await cleanupRpc(socket, "thread.delete", { threadId: thread.id, cleanupWorktree: false });
    if (deleted !== true) throw new Error("thread.delete did not confirm deletion");
    cleanup.threads.push({ threadId: thread.id, outcome: "deleted" });
  } catch (error) {
    cleanup.failures.push(`thread.delete ${thread.id}: ${safeError(error)}`);
  }
}

function isReceiptThread(thread) {
  return typeof thread?.id === "string" && Number.isInteger(thread?.ordinal);
}

function matchesReceiptThread(found, thread, runId, threadCount) {
  return found.title === expectedThreadTitle(runId, thread.ordinal, threadCount) && found.title === thread.title;
}

async function verifyThreadsRemoved(socket, threads, workspaceId, cleanup) {
  try {
    const remaining = await cleanupRpc(socket, "thread.list", { workspaceId });
    for (const thread of threads) {
      if (isOwnedThread(remaining, thread)) {
        cleanup.failures.push(`Owned thread ${thread.id} remains after cleanup`);
      }
    }
  } catch (error) {
    cleanup.failures.push(`thread.list after cleanup: ${safeError(error)}`);
  }
}

function isOwnedThread(threads, thread) {
  return typeof thread?.id === "string" && threads.some((candidate) => candidate?.id === thread.id);
}

async function restoreFixtureSetting(socket, receipt, cleanup) {
  if (receipt?.state?.fixtureSettingMayBeChanged !== true) {
    cleanup.settingsRestored = true;
    return;
  }
  try {
    const outcome = await restoreOwnedFixtureSetting(socket, receipt);
    if (outcome === "changed") {
      cleanup.failures.push("Codex CLI setting changed after this harness run; refusing to overwrite it during cleanup");
      return;
    }
    cleanup.settingsRestored = true;
  } catch (error) {
    cleanup.failures.push(`settings restore: ${safeError(error)}`);
  }
}

async function restoreOwnedFixtureSetting(socket, receipt) {
  const current = await cleanupRpc(socket, "settings.get", {});
  const configured = current?.provider?.cli?.codex;
  const fixturePath = receipt?.state?.fixtureWrapper;
  if (typeof fixturePath !== "string") throw new Error("The cleanup receipt has no fixture wrapper path");
  const absoluteFixturePath = NodePath.resolve(resolveRepoRoot(), fixturePath);
  if (configured === receipt.state.originalCodexCli) return "restored";
  if (configured !== absoluteFixturePath) return "changed";
  await cleanupRpc(socket, "settings.update", { provider: { cli: { codex: receipt.state.originalCodexCli ?? "" } } });
  return "restored";
}

function removeFixtureWrapper(receipt, repoRoot, devDir, cleanup) {
  if (!cleanup.settingsRestored || typeof receipt?.state?.fixtureWrapper !== "string") return;
  const wrapperPath = NodePath.resolve(repoRoot, receipt.state.fixtureWrapper);
  try {
    assertInsideDevDir(wrapperPath, devDir);
    if (!NodeFS.existsSync(wrapperPath)) {
      cleanup.wrapperRemoved = true;
      return;
    }
    const stat = NodeFS.lstatSync(wrapperPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Fixture wrapper is not an owned regular file");
    NodeFS.rmSync(wrapperPath);
    cleanup.wrapperRemoved = true;
  } catch (error) {
    cleanup.failures.push(`fixture wrapper removal: ${safeError(error)}`);
  }
}

async function sampleHealth(healthUrl) {
  const started = NodePerfHooks.performance.now();
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  return { durationMs: NodePerfHooks.performance.now() - started, status: response.ok ? payload?.status : `http-${response.status}` };
}

class HealthSampler {
  constructor(healthUrl, target) {
    this.healthUrl = healthUrl;
    this.target = target;
    this.timer = null;
    this.inFlight = null;
  }

  start() {
    const sample = async () => {
      if (this.inFlight) return;
      this.inFlight = sampleHealth(this.healthUrl)
        .then((result) => this.target.samples.push(result.durationMs))
        .catch(() => this.target.failures = (this.target.failures ?? 0) + 1)
        .finally(() => { this.inFlight = null; });
    };
    void sample();
    this.timer = setInterval(() => { void sample(); }, HEALTH_SAMPLE_INTERVAL_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}

class EventLoopStallSampler {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.samples = [];
    this.timer = null;
    this.expectedAt = null;
  }

  start() {
    this.expectedAt = NodePerfHooks.performance.now() + this.intervalMs;
    const tick = () => {
      const now = NodePerfHooks.performance.now();
      this.samples.push(Math.max(0, now - this.expectedAt));
      this.expectedAt += this.intervalMs;
      this.timer = setTimeout(tick, Math.max(0, this.expectedAt - NodePerfHooks.performance.now()));
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  summary() {
    return summarizeLatency(this.samples);
  }
}

class ServerLogStallReader {
  constructor(logsDirectory) {
    this.logsDirectory = logsDirectory;
    this.offsets = new Map();
    this.startedAtMs = null;
  }

  start() {
    this.startedAtMs = Date.now();
    try {
      for (const path of serverLogPaths(this.logsDirectory)) {
        this.offsets.set(path, NodeFS.statSync(path).size);
      }
    } catch {
      // The final receipt records an unavailable source without failing the workload.
    }
  }

  collect() {
    const endedAtMs = Date.now();
    const result = {
      scope: "mcode-server",
      source: "server-diagnostics-jsonl",
      observedFrom: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
      observedUntil: new Date(endedAtMs).toISOString(),
      entries: [],
      summary: null,
      unavailable: null,
    };
    if (this.startedAtMs === null) {
      result.unavailable = "server log observation did not start";
      return result;
    }
    try {
      for (const path of serverLogPaths(this.logsDirectory)) {
        const buffer = NodeFS.readFileSync(path);
        const offset = this.offsets.get(path) ?? 0;
        const contents = buffer.subarray(Math.min(offset, buffer.length)).toString("utf8");
        result.entries.push(...parseServerStallEntries(contents, this.startedAtMs, endedAtMs));
      }
      result.summary = summarizeLatency(result.entries.map((entry) => entry.stalledMs));
    } catch (error) {
      result.unavailable = safeError(error);
    }
    return result;
  }
}

function serverLogPaths(logsDirectory) {
  if (!NodeFS.existsSync(logsDirectory)) return [];
  const directory = NodeFS.lstatSync(logsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Server log directory is not a real directory");
  return NodeFS.readdirSync(logsDirectory)
    .filter((name) => /^mcode\.log\.\d{4}-\d{2}-\d{2}$/.test(name))
    .map((name) => NodePath.join(logsDirectory, name))
    .filter((path) => {
      const stats = NodeFS.lstatSync(path);
      return stats.isFile() && !stats.isSymbolicLink();
    });
}

async function readMemorySnapshot(paths) {
  const snapshot = {
    at: new Date().toISOString(),
    harnessRssBytes: process.memoryUsage().rss,
    serverWorkingSetBytes: await readServerWorkingSet(paths),
  };
  return snapshot;
}

async function readServerWorkingSet(paths) {
  if (process.platform !== "win32") return null;
  const pidPath = NodePath.join(paths.pidsDir, "server.pid");
  try {
    assertRuntimeFileSafe(pidPath, "server PID record");
    const pid = Number(NodeFS.readFileSync(pidPath, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const result = NodeChildProcess.spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return null;
    const bytes = Number(result.stdout.trim());
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

function summarizeMemory(snapshots) {
  const numbers = (field) => snapshots.map((snapshot) => snapshot[field]).filter(Number.isFinite);
  const max = (values) => values.length === 0 ? null : Math.max(...values);
  return {
    samples: snapshots.length,
    harnessRssPeakBytes: max(numbers("harnessRssBytes")),
    serverWorkingSetPeakBytes: max(numbers("serverWorkingSetBytes")),
  };
}

function summarizeModelList(models) {
  if (!Array.isArray(models)) throw new Error("provider.listModels did not return a model list");
  return { count: models.length };
}

function summarizeTerminalCapabilities(capabilities, transport) {
  return {
    contractVersion: capabilities?.contractVersion ?? null,
    backend: capabilities?.backend ?? null,
    selectedClient: transport.kind,
    lifecycle: {
      create: transport.createMethod,
      list: transport.listMethod,
      close: transport.closeMethod,
    },
  };
}

function elapsedSinceSend(thread, property) {
  if (!Number.isFinite(thread?.sentAtMs) || !Number.isFinite(thread?.[property])) return NaN;
  return thread[property] - thread.sentAtMs;
}

function throwFirstRejected(results, context) {
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw new Error(`${context}: ${safeError(rejected.reason)}`);
}

function ensureRealDirectory(directory, devDir) {
  assertInsideDevDir(directory, devDir);
  NodeFS.mkdirSync(directory, { recursive: true });
  let current = NodePath.resolve(devDir);
  const target = NodePath.resolve(directory);
  const relative = NodePath.relative(current, target);
  const parts = relative === "" ? [] : relative.split(NodePath.sep);
  for (const part of ["", ...parts]) {
    if (part) current = NodePath.join(current, part);
    const stats = NodeFS.lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error("Performance evidence directory must not be a link");
  }
}

function resolveReceiptPath(repoRoot, receiptPath, devDir) {
  const resolved = NodePath.resolve(repoRoot, receiptPath);
  assertInsideDevDir(resolved, devDir);
  const relative = NodePath.relative(NodePath.join(repoRoot, ...PERFORMANCE_DIRECTORY), resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative) || NodePath.basename(resolved) !== "receipt.json") {
    throw new Error("Cleanup accepts only a seven-thread performance receipt under .dev/verification/performance");
  }
  return resolved;
}

function readReceipt(receiptPath, devDir) {
  assertInsideDevDir(receiptPath, devDir);
  assertRuntimeFileSafe(receiptPath, "performance receipt");
  const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
  if (!receipt || receipt.schemaVersion !== 1 || typeof receipt.runId !== "string" || !receipt.state || !Array.isArray(receipt.state.threads)) {
    throw new Error("The cleanup receipt has an unexpected shape");
  }
  return receipt;
}

function writeReceipt(receiptPath, receipt, devDir) {
  assertInsideDevDir(receiptPath, devDir);
  const directory = NodePath.dirname(receiptPath);
  ensureRealDirectory(directory, devDir);
  const temporary = `${receiptPath}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, receiptPath);
}

function samePath(left, right) {
  return NodePath.resolve(left).replace(/\\/g, "/").toLowerCase() === NodePath.resolve(right).replace(/\\/g, "/").toLowerCase();
}

function relativePath(repoRoot, path) {
  return NodePath.relative(repoRoot, path).replace(/\\/g, "/");
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const result = args.command === "run"
    ? await runLiveHarness({ label: args.label, stopOne: args.stopOne })
    : await cleanupReceipt({ receiptPath: args.receiptPath });
  process.stdout.write(`${JSON.stringify({ ok: true, receiptPath: relativePath(resolveRepoRoot(), result.receiptPath) })}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
