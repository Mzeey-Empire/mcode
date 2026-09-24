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
import { performance } from "node:perf_hooks";

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

const HELP = `Seven concurrent thread live performance harness

Usage:
  bun scripts/perf/seven-thread-live-harness.mjs --run --confirm-run --label <before|after>
  bun scripts/perf/seven-thread-live-harness.mjs --cleanup <receipt-path> --confirm-cleanup
  bun scripts/perf/seven-thread-live-harness.mjs --cleanup-receipt <receipt-path> --confirm-run

The run command creates exactly seven direct threads in this worktree's
.dev/fixture-repo. It temporarily routes Codex through the checked-in
transcript fixture and restores the previous setting during cleanup. It never
falls back to a real Codex model or prints runtime credentials.
`;

/** Parses the small explicit command surface before any runtime mutation. */
export function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { command: "help" };
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    if (["--run", "--confirm-run", "--confirm-cleanup"].includes(token)) {
      if (flags.has(token)) throw new Error(`Duplicate option: ${token}`);
      flags.add(token);
      continue;
    }
    if (token !== "--label" && token !== "--cleanup" && token !== "--cleanup-receipt") throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (values.has(token)) throw new Error(`Duplicate option: ${token}`);
    values.set(token, value);
    index += 1;
  }

  const wantsRun = flags.has("--run");
  const cleanupPath = values.get("--cleanup");
  const cleanupReceiptPath = values.get("--cleanup-receipt");
  if (cleanupPath && cleanupReceiptPath) throw new Error("Choose exactly one cleanup receipt option");
  const selectedCleanupPath = cleanupPath ?? cleanupReceiptPath;
  if (wantsRun === Boolean(selectedCleanupPath)) throw new Error("Choose exactly one of --run or cleanup receipt");
  if (wantsRun) {
    if (!flags.has("--confirm-run")) throw new Error("--run requires --confirm-run");
    if (flags.has("--confirm-cleanup") || cleanupPath || cleanupReceiptPath) throw new Error("--run cannot include cleanup options");
    const label = values.get("--label");
    if (label !== "before" && label !== "after") throw new Error("--run requires --label before or --label after");
    return { command: "run", label };
  }
  if (cleanupReceiptPath) {
    if (!flags.has("--confirm-run") || flags.has("--confirm-cleanup") || values.has("--label")) {
      throw new Error("--cleanup-receipt requires --confirm-run and cannot include run options");
    }
    return { command: "cleanup", receiptPath: cleanupReceiptPath };
  }
  if (!flags.has("--confirm-cleanup")) throw new Error("--cleanup requires --confirm-cleanup");
  if (flags.has("--confirm-run") || values.has("--label")) throw new Error("--cleanup cannot include run options");
  return { command: "cleanup", receiptPath: cleanupPath };
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
  const sequences = events.map((event) => event.sequence).filter(Number.isInteger);
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
  const largestSequence = sequences.length === 0 ? 0 : Math.max(...sequences);
  const missingSequences = [];
  for (let sequence = 1; sequence <= largestSequence; sequence += 1) {
    if (!seen.has(sequence)) missingSequences.push(sequence);
  }
  return {
    received: events.length,
    firstSequence: sequences.length === 0 ? null : Math.min(...sequences),
    lastSequence: largestSequence || null,
    missingSequences,
    duplicateSequences: duplicates,
    arrivalOrderViolations,
    sequenceValid: sequences.length === events.length && missingSequences.length === 0 && duplicates.length === 0 && arrivalOrderViolations.length === 0,
    completed: events.some((event) => event.type === "turnComplete"),
  };
}

/** Selects the exact Terminal lifecycle RPC family that the web transport selects. */
export function selectTerminalTransport(capabilities) {
  if (capabilities?.contractVersion === 1 && capabilities?.backend === "modern") {
    return {
      kind: "modern",
      createMethod: "terminal.session.create",
      listMethod: "terminal.session.list",
      closeMethod: "terminal.session.close",
    };
  }
  if (capabilities?.contractVersion === 0 && capabilities?.backend === "legacy") {
    return {
      kind: "legacy",
      createMethod: "terminal.create",
      listMethod: "terminal.listActive",
      closeMethod: "terminal.kill",
    };
  }
  throw new Error("terminal.capabilities did not select a supported Terminal client");
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
  return contents.split(/\r?\n/).flatMap((line) => {
    if (!line) return [];
    try {
      const entry = JSON.parse(line);
      const timestampMs = Date.parse(entry?.timestamp);
      if (entry?.message !== "Event loop stalled" || !Number.isFinite(timestampMs)
        || timestampMs < startedAtMs || timestampMs > endedAtMs || !Number.isFinite(entry?.stalledMs)) return [];
      return [{ timestamp: entry.timestamp, stalledMs: entry.stalledMs }];
    } catch {
      return [];
    }
  });
}

/** Creates the stable names used to prove that only this harness owns a thread. */
export function expectedThreadTitle(runId, ordinal) {
  return `Seven-thread live performance ${runId} ${ordinal}/${THREAD_COUNT}`;
}

/** Runs the fixed seven-thread workload and writes its recovery-capable receipt. */
export async function runLiveHarness({ repoRoot = resolveRepoRoot(), label }) {
  const paths = getRuntimePaths(repoRoot);
  const ports = requireLocalRuntime(repoRoot);
  const run = createRun(repoRoot, label);
  const receipt = createReceipt(run, label);
  const eventLoop = new EventLoopStallSampler(EVENT_LOOP_INTERVAL_MS);
  const serverStalls = new ServerLogStallReader(paths.logsDir);
  const healthSampler = new HealthSampler(ports.healthUrl, receipt.metrics.health);
  const eventState = new Map();
  const terminalEvents = new TerminalEventWaiter(eventState);
  const turnStarts = new TurnStartWaiter(eventState);
  let socket = null;
  let primaryError = null;

  writeReceipt(run.receiptPath, receipt, paths.devDir);
  eventLoop.start();
  serverStalls.start();
  try {
    const initialHealth = await sampleHealth(ports.healthUrl);
    receipt.metrics.health.samples.push(initialHealth.durationMs);
    if (initialHealth.status !== "ok") throw new Error("The worktree runtime health endpoint did not return status=ok");

    socket = await openRuntimeVerificationSocket(repoRoot, (push) => capturePush(push, eventState, terminalEvents, turnStarts));
    const activeAgents = await measuredRpc(socket, receipt.metrics.rpc, "agent.activeCount", {});
    const preflightActiveCount = {
      phase: "before-dispatch",
      activeAgents,
      active: activeAgents > 0,
      observedAt: new Date().toISOString(),
    };
    receipt.state.activeTurnAssertions.push(preflightActiveCount);
    if (preflightActiveCount.active) throw new Error("The worktree runtime is busy; the harness will not change the Codex CLI setting while agents are active");

    const workspace = await requireFixtureWorkspace(socket, paths.fixtureRepoDir);
    receipt.workspace = { id: workspace.id, path: relativePath(repoRoot, paths.fixtureRepoDir) };
    receipt.state.phase = "fixture-setup";
    const settings = await measuredRpc(socket, receipt.metrics.rpc, "settings.get", {});
    receipt.state.originalCodexCli = settings?.provider?.cli?.codex ?? "";

    if (process.platform !== "win32") throw new Error("The controlled Codex fixture currently requires the Windows command wrapper");
    try {
      createFixtureWrapper(run.fixtureWrapperPath, repoRoot, paths.devDir);
      receipt.state.fixtureWrapper = relativePath(repoRoot, run.fixtureWrapperPath);
      receipt.state.fixtureSettingMayBeChanged = true;
      writeReceipt(run.receiptPath, receipt, paths.devDir);
      await measuredRpc(socket, receipt.metrics.rpc, "settings.update", {
        provider: { cli: { codex: run.fixtureWrapperPath } },
      });
    } catch (error) {
      throw new Error(`The controlled Codex fixture could not be configured: ${safeError(error)}. No real Codex fallback was attempted; explicit approval is required before one can be used.`);
    }
    receipt.state.fixtureConfigured = true;
    writeReceipt(run.receiptPath, receipt, paths.devDir);

    healthSampler.start();
    receipt.metrics.memory.push(await readMemorySnapshot(paths));

    const branch = currentFixtureBranch(paths.fixtureRepoDir);
    receipt.state.phase = "creating-threads";
    const threadCreation = await Promise.allSettled(Array.from({ length: THREAD_COUNT }, async (_, index) => {
      const ordinal = index + 1;
      const title = expectedThreadTitle(run.id, ordinal);
      const thread = await measuredRpc(socket, receipt.metrics.rpc, "thread.create", {
        workspaceId: workspace.id,
        title,
        mode: "direct",
        branch,
      });
      const record = { id: thread?.id, title, ordinal, events: [], ptyId: null, sentAtMs: null, startedAtMs: null, completedAtMs: null, persistedAtMs: null, durable: null };
      if (typeof record.id !== "string" || record.id.length === 0) throw new Error(`Thread ${ordinal} did not return an ID`);
      receipt.state.threads.push(record);
      eventState.set(record.id, record);
      writeReceipt(run.receiptPath, receipt, paths.devDir);
      return record;
    }));
    throwFirstRejected(threadCreation, "Creating verifier-owned direct threads failed");
    if (receipt.state.threads.length !== THREAD_COUNT) throw new Error("The harness did not create exactly seven threads");

    const threadIds = receipt.state.threads.map((thread) => thread.id);
    await measuredRpc(socket, receipt.metrics.rpc, "push.setThreadSubscriptions", {
      threadIds,
      cursors: Object.fromEntries(threadIds.map((threadId) => [threadId, 0])),
    });
    receipt.state.phase = "preflighting-terminal-transport";
    const preflightTerminalCapabilities = await measuredRpc(socket, receipt.metrics.rpc, "terminal.capabilities", {}, "terminal.capabilities.preflight", CONTROL_RPC_TIMEOUT_MS);
    const terminalTransport = selectTerminalTransport(preflightTerminalCapabilities);
    receipt.state.terminalTransport = terminalTransport;
    writeReceipt(run.receiptPath, receipt, paths.devDir);

    const completed = terminalEvents.wait(TURN_TIMEOUT_MS);
    const started = turnStarts.wait(TURN_TIMEOUT_MS);
    receipt.state.phase = "sending-turns";
    const sends = await Promise.allSettled(receipt.state.threads.map(async (thread) => {
      thread.sentAtMs = performance.now();
      await measuredRpc(socket, receipt.metrics.rpc, "agent.send", {
        threadId: thread.id,
        content: FIXTURE_PROMPT,
        messageId: NodeCrypto.randomUUID(),
        provider: PROVIDER_ID,
        model: WORKLOAD_MODEL,
        permissionMode: "full",
      });
    }));
    throwFirstRejected(sends, "Dispatching the controlled fixture turns failed");
    receipt.metrics.memory.push(await readMemorySnapshot(paths));
    await started;

    receipt.state.phase = "sampling-active-controls";
    const controlLaunch = createControlLaunch(receipt.state.threads);
    receipt.state.activeControlLaunch = controlLaunch;
    receipt.state.terminalCreateInconclusive = controlLaunch.inconclusive;
    writeReceipt(run.receiptPath, receipt, paths.devDir);

    // This starts all nine user-facing control requests before awaiting any of
    // them. The preflight above chose the same lifecycle family the web client
    // would use, without making terminal creation wait on an overloaded RPC.
    const controlRequests = launchActiveControlRequests({
      socket,
      metrics: receipt.metrics.rpc,
      workspaceId: workspace.id,
      terminalTransport,
      threads: receipt.state.threads,
      persistTerminal: (thread, terminal) => {
        if (typeof terminal?.ptyId !== "string" || terminal.ptyId.length === 0) throw new Error(`Terminal create did not return a PTY for thread ${thread.ordinal}`);
        thread.ptyId = terminal.ptyId;
        writeReceipt(run.receiptPath, receipt, paths.devDir);
      },
    });
    const controlResults = await Promise.allSettled(controlRequests.map((request) => request.promise));
    throwFirstRejected(controlResults, "Sampling active controls and creating verifier-owned terminal PTYs failed");
    const models = controlResults[0].value;
    const activeTerminalCapabilities = controlResults[1].value;
    const activeTerminalTransport = selectTerminalTransport(activeTerminalCapabilities);
    if (activeTerminalTransport.kind !== terminalTransport.kind) {
      throw new Error("terminal.capabilities selected a different Terminal client after dispatch");
    }
    receipt.modelList = { ...summarizeModelList(models), activeTurnAssertion: controlLaunch, inconclusive: controlLaunch.inconclusive };
    receipt.terminalCapabilities = {
      ...summarizeTerminalCapabilities(activeTerminalCapabilities, activeTerminalTransport),
      preflight: summarizeTerminalCapabilities(preflightTerminalCapabilities, terminalTransport),
      activeTurnAssertion: controlLaunch,
      inconclusive: controlLaunch.inconclusive,
    };
    if (receipt.state.threads.some((thread) => typeof thread.ptyId !== "string")) throw new Error("The harness did not create a PTY for every owned thread");
    receipt.state.phase = "waiting-for-events";
    await completed;

    receipt.state.phase = "reading-durable-conversations";
    const durableReads = await Promise.allSettled(receipt.state.threads.map(async (thread) => {
      const tail = await measuredRpc(socket, receipt.metrics.rpc, "conversation.tail", { threadId: thread.id, limit: 2 });
      thread.durable = auditConversationTail(tail);
      if (!thread.durable.ok) throw new Error(`Durable conversation proof failed for thread ${thread.ordinal}`);
    }));
    throwFirstRejected(durableReads, "Reading durable conversation tails failed");
    receipt.metrics.memory.push(await readMemorySnapshot(paths));

    const finalActiveAgents = await measuredRpc(socket, receipt.metrics.rpc, "agent.activeCount", {});
    if (finalActiveAgents !== 0) throw new Error("The controlled turns completed but the runtime still reports active agents");
    if (receipt.modelList?.inconclusive || receipt.terminalCapabilities?.inconclusive || receipt.state.terminalCreateInconclusive) {
      throw new Error("The active-turn control samples were inconclusive because all fixture turns finished before a required RPC could begin");
    }
    if (!auditRun(receipt)) throw new Error("The controlled workload completed with event-loss, order, completion, or durability failures");
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    receipt.failure = safeError(primaryError);
  } finally {
    await healthSampler.stop();
    eventLoop.stop();
    if (socket) {
      const cleanup = await cleanupOwnedResources(socket, receipt, paths, repoRoot);
      receipt.cleanup = cleanup;
      if (!cleanup.ok && !primaryError) primaryError = new Error("The workload completed but owned-resource cleanup was incomplete");
    }
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
    receipt.state.phase = primaryError ? "failed" : "complete";
    receipt.ok = primaryError === null && receipt.cleanup?.ok === true && receipt.metrics.events.ok;
    if (receipt.cleanup?.settingsRestored === true) {
      delete receipt.state.originalCodexCli;
      receipt.state.fixtureSettingMayBeChanged = false;
    }
    writeReceipt(run.receiptPath, receipt, paths.devDir);
    if (socket) await socket.close().catch(() => undefined);
  }
  if (primaryError) throw primaryError;
  return { receiptPath: run.receiptPath, receipt };
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

function createReceipt(run, label) {
  return {
    schemaVersion: 1,
    runId: run.id,
    label,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ok: false,
    workload: {
      threadCount: THREAD_COUNT,
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
  if (transport.kind === "legacy"
    && transport.createMethod === "terminal.create"
    && transport.listMethod === "terminal.listActive"
    && transport.closeMethod === "terminal.kill") return transport;
  if (transport.kind === "modern"
    && transport.createMethod === "terminal.session.create"
    && transport.listMethod === "terminal.session.list"
    && transport.closeMethod === "terminal.session.close") return transport;
  throw new Error("The cleanup receipt has an invalid Terminal transport");
}

async function measuredRpc(socket, metrics, method, params, metricName = method, timeoutMs) {
  const started = performance.now();
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : undefined;
  const result = await socket.rpc(method, params, deadline);
  recordMetric(metrics, metricName, performance.now() - started);
  return result;
}

function recordMetric(metrics, name, durationMs) {
  const samples = metrics[name] ?? [];
  samples.push(durationMs);
  metrics[name] = samples;
}

function capturePush(push, state, terminalEvents, turnStarts) {
  if (push?.type !== "push") return;
  const data = push.data;
  if (!data || typeof data !== "object" || typeof data.threadId !== "string") return;
  const thread = state.get(data.threadId);
  if (!thread) return;
  const now = performance.now();
  if (push.channel === "agent.event") {
    thread.events.push({ sequence: data.sequence, type: data.type, atMs: now });
    if (data.type === "turnStarted") {
      thread.startedAtMs ??= now;
      turnStarts.notify();
    }
    if (data.type === "turnComplete") thread.completedAtMs ??= now;
  } else if (push.channel === "turn.persisted") {
    thread.persistedAtMs ??= now;
  }
  terminalEvents.notify();
}

/** Records whether public turn events still show work in flight when controls launch. */
export function createControlLaunch(threads, launchedAtMs = performance.now()) {
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
  constructor(state) {
    this.state = state;
    this.resolve = null;
  }

  wait(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolve = null;
        reject(new Error("Not every controlled thread produced both turn completion and durable persistence events before the deadline"));
      }, timeoutMs);
      this.resolve = () => {
        if (![...this.state.values()].every((thread) => thread.completedAtMs !== null && thread.persistedAtMs !== null)) return;
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
        if (![...this.state.values()].some((thread) => thread.startedAtMs !== null)) return;
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

function auditRun(receipt) {
  return receipt.state.threads.every((thread) => {
    thread.eventAudit = auditAgentEvents(thread.events);
    return thread.eventAudit.sequenceValid && thread.eventAudit.completed && thread.durable?.ok === true;
  });
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
    ok: audits.length === THREAD_COUNT && audits.every((audit) => audit.sequenceValid && audit.completed),
  };
}

async function cleanupOwnedResources(socket, receipt, paths, repoRoot) {
  const cleanup = { ok: true, ptys: [], threads: [], settingsRestored: false, wrapperRemoved: false, failures: [] };
  const threads = Array.isArray(receipt?.state?.threads) ? receipt.state.threads : [];
  const workspace = receipt?.workspace;
  let terminalTransport = null;
  try {
    const fixture = await requireFixtureWorkspace(socket, paths.fixtureRepoDir, cleanupDeadline());
    if (!workspace || fixture.id !== workspace.id) throw new Error("The cleanup receipt does not belong to this worktree fixture workspace");
  } catch (error) {
    cleanup.failures.push(safeError(error));
  }
  if (threads.length > 0 && receipt?.state?.terminalTransport) {
    try {
      terminalTransport = terminalTransportFromReceipt(receipt);
    } catch (error) {
      cleanup.failures.push(safeError(error));
    }
  }
  if (cleanup.failures.length === 0) {
    if (terminalTransport) await cleanupPtys(socket, threads, terminalTransport, cleanup);
    await cleanupThreads(socket, threads, workspace.id, receipt.runId, cleanup);
  }
  await restoreFixtureSetting(socket, receipt, cleanup);
  removeFixtureWrapper(receipt, repoRoot, paths.devDir, cleanup);
  cleanup.ok = cleanup.failures.length === 0;
  return cleanup;
}

async function cleanupPtys(socket, threads, transport, cleanup) {
  let active = [];
  try {
    active = normalizeTerminalSessions(transport, await cleanupRpc(socket, transport.listMethod, {}));
  } catch (error) {
    cleanup.failures.push(`${transport.listMethod}: ${safeError(error)}`);
    return;
  }
  for (const thread of threads) {
    if (typeof thread?.id !== "string") continue;
    const ownedPtys = active.filter((pty) => pty?.threadId === thread.id);
    if (ownedPtys.length === 0) {
      if (typeof thread.ptyId === "string") cleanup.ptys.push({ ptyId: thread.ptyId, outcome: "already-closed" });
      continue;
    }
    for (const current of ownedPtys) {
      if (typeof current.ptyId !== "string") {
        cleanup.failures.push(`Refusing to kill a PTY with no ID for verifier thread ${thread.id}`);
        continue;
      }
      thread.ptyId ??= current.ptyId;
      if (current.state === "exited" || current.state === "failed") {
        cleanup.ptys.push({ ptyId: current.ptyId, outcome: "already-closed" });
        continue;
      }
      try {
        await closeTerminal(socket, transport, current.ptyId);
        cleanup.ptys.push({ ptyId: current.ptyId, outcome: "killed" });
      } catch (error) {
        cleanup.failures.push(`${transport.closeMethod} ${current.ptyId}: ${safeError(error)}`);
      }
    }
  }
  try {
    const remaining = normalizeTerminalSessions(transport, await cleanupRpc(socket, transport.listMethod, {}));
    if (!Array.isArray(remaining)) throw new Error("terminal.listActive did not return a list");
    for (const thread of threads) {
      if (typeof thread?.id === "string" && remaining.some((pty) => pty?.threadId === thread.id && pty.state === "running")) {
        cleanup.failures.push(`An owned PTY remains active for verifier thread ${thread.id} after cleanup`);
      }
    }
  } catch (error) {
    cleanup.failures.push(`${transport.listMethod} after cleanup: ${safeError(error)}`);
  }
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

async function cleanupThreads(socket, threads, workspaceId, runId, cleanup) {
  let current;
  try {
    current = await cleanupRpc(socket, "thread.list", { workspaceId });
  } catch (error) {
    cleanup.failures.push(`thread.list: ${safeError(error)}`);
    return;
  }
  for (const thread of threads) {
    if (typeof thread?.id !== "string" || !Number.isInteger(thread?.ordinal)) continue;
    const found = current.find((candidate) => candidate?.id === thread.id);
    if (!found) {
      cleanup.threads.push({ threadId: thread.id, outcome: "already-deleted" });
      continue;
    }
    if (found.title !== expectedThreadTitle(runId, thread.ordinal) || found.title !== thread.title) {
      cleanup.failures.push(`Refusing to delete thread ${thread.id}: title does not match this receipt`);
      continue;
    }
    try {
      const deleted = await cleanupRpc(socket, "thread.delete", { threadId: thread.id, cleanupWorktree: false });
      if (deleted !== true) throw new Error("thread.delete did not confirm deletion");
      cleanup.threads.push({ threadId: thread.id, outcome: "deleted" });
    } catch (error) {
      cleanup.failures.push(`thread.delete ${thread.id}: ${safeError(error)}`);
    }
  }
  try {
    const remaining = await cleanupRpc(socket, "thread.list", { workspaceId });
    for (const thread of threads) {
      if (typeof thread?.id === "string" && remaining.some((candidate) => candidate?.id === thread.id)) {
        cleanup.failures.push(`Owned thread ${thread.id} remains after cleanup`);
      }
    }
  } catch (error) {
    cleanup.failures.push(`thread.list after cleanup: ${safeError(error)}`);
  }
}

async function restoreFixtureSetting(socket, receipt, cleanup) {
  if (receipt?.state?.fixtureSettingMayBeChanged !== true) {
    cleanup.settingsRestored = true;
    return;
  }
  try {
    const current = await cleanupRpc(socket, "settings.get", {});
    const configured = current?.provider?.cli?.codex;
    const fixturePath = receipt?.state?.fixtureWrapper;
    if (typeof fixturePath !== "string") throw new Error("The cleanup receipt has no fixture wrapper path");
    const absoluteFixturePath = NodePath.resolve(resolveRepoRoot(), fixturePath);
    if (configured === receipt.state.originalCodexCli) {
      cleanup.settingsRestored = true;
      return;
    }
    if (configured !== absoluteFixturePath) {
      cleanup.failures.push("Codex CLI setting changed after this harness run; refusing to overwrite it during cleanup");
      return;
    }
    await cleanupRpc(socket, "settings.update", { provider: { cli: { codex: receipt.state.originalCodexCli ?? "" } } });
    cleanup.settingsRestored = true;
  } catch (error) {
    cleanup.failures.push(`settings restore: ${safeError(error)}`);
  }
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
  const started = performance.now();
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  return { durationMs: performance.now() - started, status: response.ok ? payload?.status : `http-${response.status}` };
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
    this.expectedAt = performance.now() + this.intervalMs;
    const tick = () => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.expectedAt));
      this.expectedAt += this.intervalMs;
      this.timer = setTimeout(tick, Math.max(0, this.expectedAt - performance.now()));
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
    ? await runLiveHarness({ label: args.label })
    : await cleanupReceipt({ receiptPath: args.receiptPath });
  process.stdout.write(`${JSON.stringify({ ok: true, receiptPath: relativePath(resolveRepoRoot(), result.receiptPath) })}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
