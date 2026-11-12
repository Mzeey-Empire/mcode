import "reflect-metadata";
import { SessionOccupancyRegistry } from "../../../session-occupancy/session-occupancy-registry.js";
import { TurnFileEvidenceLedger } from "../../execution/turn-file-evidence-ledger.js";
import { bindTurnFileEvidenceLedger } from "../../execution/turn-persisted-publication.js";
import { listTurnFileEvidence } from "../../turns/persistence/turn-file-evidence-store.js";
import { SNAPSHOT_CAPTURE_BUDGET_MS, SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { container } from "tsyringe";
import { logger } from "@mcode/shared";
import { diag, parseDiagLine, threadRecordingFileId } from "@mcode/shared/diagnostics";
import { SERVER_SHUTDOWN_DEADLINE_MS, SHUTDOWN_PERSISTENCE_START_MS } from "@mcode/shared/node/shutdown-deadlines";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { CodexChildEvidence } from "@mcode/contracts/events/provider-runtime-event";
import { createAgentModelState, reduceAgentEventBatch } from "@mcode/contracts/compat/agent-model";
import type { PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import { broadcast } from "../../../../application/transport/push.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { TurnRecoveryService } from "../../recovery/turn-recovery-service.js";
import { SubagentRosterService } from "../../collaboration/subagent-roster-service.js";
import { SessionRuntime } from "../../../providers/runtime/session-runtime.js";
import { runShutdownPhases } from "../../../../runtime/lifecycle/shutdown-phases.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { TurnRuntimeController } from "../turn-runtime-controller.js";
import { appendPreviewAnnotations, sendRecoveryAttempt } from "../../transport/turn-message-dispatch.js";
import { openWorkerServiceFixture } from "./worker-turn-fixture.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

type WorkerFixture = Awaited<ReturnType<typeof openWorkerServiceFixture>>;
let activeFixture: WorkerFixture | undefined;

async function openFixture(providerId: ProviderId = "codex") {
  activeFixture = await openWorkerServiceFixture(providerId);
  return activeFixture;
}

async function sendTurn(fixture: WorkerFixture) {
  await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work", provider: fixture.provider.id, model: fixture.provider.id === "claude" ? "claude-sonnet-4-6" : "gpt-5", permissionMode: "default" });
  await vi.waitFor(() => expect(fixture.sent).toHaveLength(1));
  const turn = fixture.sent.at(-1);
  if (!turn) throw new Error("Provider did not receive the turn");
  return turn;
}

function turnComplete(threadId: string, turnExecutionId: string, providerId: ProviderId = "codex"): AgentEvent {
  return { type: "turnComplete", threadId, turnExecutionId, reason: "end_turn", costUsd: null, tokensIn: 1, tokensOut: 1, providerId };
}

function captureTurnRelease(fixture: WorkerFixture) {
  const turn = container.resolve(TurnRuntimeController).workerTurnForTest(fixture.thread.id);
  if (!turn) throw new Error("Worker turn is unavailable before release");
  return async () => {
    try {
      await turn.terminalRelease;
      await turn.ending;
    } finally {
      // Whether the ending saved its own outcome or recovery did, the turn must no longer own the worker.
      await vi.waitFor(() => expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined());
      await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    }
  };
}

/** A provider that answers well after shutdown starts but inside the drain bound. */
const SLOW_PROVIDER_MS = 6_000;

/** Ends the process without a graceful agent stop and opens the same database, as the next server start does. */
async function restart(fixture: WorkerFixture): Promise<WorkerFixture> {
  await fixture.close({ graceful: false, keepDirectory: true });
  activeFixture = await openWorkerServiceFixture("codex", { directory: fixture.directory, threadId: fixture.thread.id });
  return activeFixture;
}

async function endTurn(fixture: WorkerFixture, event: Extract<AgentEvent, { type: "ended" }>) {
  const waitForRelease = captureTurnRelease(fixture);
  await fixture.emit(event);
  await waitForRelease();
}

async function spawnChild(fixture: WorkerFixture, executionId: string, name: string, parent?: CodexChildEvidence) {
  const evidence = { nativeThreadId: `native-${name}-thread`, nativeTurnId: `native-${name}-turn`, parentCollaborationItemId: name };
  await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, turnExecutionId: executionId,
    toolCallId: name, toolName: "Agent", toolInput: {} }, {
    providerId: "codex", kind: "codex-collaboration",
    ...(parent ? { child: { ...parent, nativeItemId: name } } : {}),
    collaboration: { kind: "spawnAgent", receiverThreadIds: [evidence.nativeThreadId], prompt: "Inspect the fixture" },
  });
  await fixture.emit({ type: "turnStarted", threadId: fixture.thread.id, turnExecutionId: executionId }, {
    providerId: "codex", kind: "codex-collaboration", child: evidence,
  });
  const delegation = fixture.canonical.loadCodexChildDelegationByReceiverThreadId(evidence.nativeThreadId);
  if (!delegation) throw new Error("Provider did not create a durable child delegation");
  return { ...delegation, evidence };
}

/**
 * A graceful close runs `stopAll`, which may wait out the 15 s provider-stop bound and then the 15 s
 * worker-drain bound in `turn-runtime-controller.ts`. Vitest's default 10 s hook timeout would fail
 * a close that is still inside those bounds.
 */
const FIXTURE_CLOSE_TIMEOUT_MS = 45_000;

function holdDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
  vi.restoreAllMocks();
}, FIXTURE_CLOSE_TIMEOUT_MS);

describe("AgentService cleanup through production worker composition", { timeout: 30_000 }, () => {
  it("advances lastUserTurnAt only for an admitted user-sent turn", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fixture = await openFixture("claude");
    const occupancy = container.resolve(SessionOccupancyRegistry);
    const key = { providerId: "claude", threadId: fixture.thread.id };
    occupancy.openSession(key);
    expect(occupancy.read(key, now).lastUserTurnAt).toBeNull();

    now += 1_000;
    const userSentAt = now;
    const userTurn = await sendTurn(fixture);
    expect(occupancy.read(key, now).lastUserTurnAt).toBe(userSentAt);
    await fixture.emit(turnComplete(fixture.thread.id, userTurn.turnExecutionId, "claude"));
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: userTurn.turnExecutionId });

    for (const origin of [{ providerOriginated: true }, { delegationWake: true }]) {
      now += 1_000;
      const sentBefore = fixture.sent.length;
      await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Continue background work",
        provider: "claude", model: "claude-sonnet-4-6", permissionMode: "default", ...origin });
      await vi.waitFor(() => expect(fixture.sent).toHaveLength(sentBefore + 1));
      expect(occupancy.read(key, now).lastUserTurnAt).toBe(userSentAt);
      const turn = fixture.sent.at(-1);
      if (!turn) throw new Error("Provider did not receive the continuation");
      await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId, "claude"));
      await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    }
  });

  it("returns Stop and publishes its ending while capture is wedged, gating the next send for the file check budget", async () => {
    const fixture = await openFixture();
    const snapshots = container.resolve(SnapshotService);
    const capture = vi.spyOn(snapshots, "captureRef").mockResolvedValueOnce("a".repeat(40));
    const ledger = new TurnFileEvidenceLedger(fixture.db, fixture.writer, snapshots);
    container.resolve(TurnRuntimeController).bindFileEvidence(ledger);
    bindTurnFileEvidenceLedger(ledger);
    await sendTurn(fixture);
    capture.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped.status).toBe("cancelled");
      await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
      expect(vi.mocked(broadcast).mock.calls.some(([channel]) => channel === "turn.persisted")).toBe(true);
      let sent = false;
      const next = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Next", provider: "codex", model: "gpt-5", permissionMode: "default" }).then(() => { sent = true; });
      await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_BUDGET_MS - 1);
      expect(sent).toBe(false);
      expect(fixture.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await next;
      expect(listTurnFileEvidence(fixture.db, { threadId: fixture.thread.id })[0]?.evidence).toEqual({ state: "unavailable", reason: "timed-out", knownPaths: [] });
      expect(fixture.sent).toHaveLength(2);
    } finally { vi.useRealTimers(); ledger.close(); }
  });

  it("returns a Stop that lands before provider dispatch while capture is wedged, gating the next send", async () => {
    const fixture = await openFixture();
    const snapshots = container.resolve(SnapshotService);
    const capture = vi.spyOn(snapshots, "captureRef").mockResolvedValueOnce("a".repeat(40));
    const ledger = new TurnFileEvidenceLedger(fixture.db, fixture.writer, snapshots);
    container.resolve(TurnRuntimeController).bindFileEvidence(ledger);
    bindTurnFileEvidenceLedger(ledger);
    const reservations = container.resolve(ThreadControlMutationReservationService);
    const runIfOwned = reservations.runIfOwned.bind(reservations);
    const bound = holdDeferred();
    const dispatchHeld = holdDeferred();
    vi.spyOn(reservations, "runIfOwned").mockImplementation((threadId, token, kind, run) => kind !== "activeTurn"
      ? runIfOwned(threadId, token, kind, run)
      : (bound.resolve(), dispatchHeld.promise.then(() => runIfOwned(threadId, token, kind, run))));
    const first = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work", provider: "codex", model: "gpt-5", permissionMode: "default" });
    await bound.promise;
    capture.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped).toMatchObject({ status: "cancelled", dispatchState: "not-dispatched" });
      dispatchHeld.resolve();
      await first;
      await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
      let sent = false;
      const next = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Next", provider: "codex", model: "gpt-5", permissionMode: "default" }).then(() => { sent = true; });
      await vi.advanceTimersByTimeAsync(SNAPSHOT_CAPTURE_BUDGET_MS - 1);
      expect(sent).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await next;
      expect(listTurnFileEvidence(fixture.db, { threadId: fixture.thread.id })[0]?.evidence).toMatchObject({ state: "unavailable", reason: "timed-out" });
      expect(fixture.sent.map((turn) => turn.message)).toEqual(["Next"]);
    } finally { dispatchHeld.resolve(); vi.useRealTimers(); ledger.close(); }
  });

  it("unlocks the thread when the release after an early Stop fails", async () => {
    const fixture = await openFixture();
    const reservations = container.resolve(ThreadControlMutationReservationService);
    const runIfOwned = reservations.runIfOwned.bind(reservations);
    const bound = holdDeferred();
    const dispatchHeld = holdDeferred();
    vi.spyOn(reservations, "runIfOwned").mockImplementation((threadId, token, kind, run) => kind !== "activeTurn"
      ? runIfOwned(threadId, token, kind, run)
      : (bound.resolve(), dispatchHeld.promise.then(() => runIfOwned(threadId, token, kind, run))));
    const first = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work", provider: "codex", model: "gpt-5", permissionMode: "default" });
    await bound.promise;
    vi.spyOn(fixture.workers.owner, "release").mockRejectedValueOnce(new Error("worker slot release failed"));
    try {
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped).toMatchObject({ status: "cancelled", dispatchState: "not-dispatched" });
      dispatchHeld.resolve();
      await first;
      await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Next", provider: "codex", model: "gpt-5", permissionMode: "default" });
      await vi.waitFor(() => expect(fixture.sent.map((turn) => turn.message)).toEqual(["Next"]));
      expect(fixture.canonical.loadTurnByExecution(stopped.turnExecutionId!)?.ending).toEqual({ outcome: "cancelled", stop: { by: "user" } });
    } finally { dispatchHeld.resolve(); }
  });

  it("keeps Stop's cancelled state when the release after a Stop during file preparation fails", async () => {
    const fixture = await openFixture();
    const preparing = holdDeferred();
    const baseline = holdDeferred();
    vi.spyOn(container.resolve(SnapshotService), "captureRef").mockImplementationOnce(async () => {
      preparing.resolve();
      await baseline.promise;
      return "a".repeat(40);
    });
    const first = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work", provider: "codex", model: "gpt-5", permissionMode: "default" }).catch(() => undefined);
    await preparing.promise;
    vi.spyOn(fixture.workers.owner, "release").mockRejectedValueOnce(new Error("worker slot release failed"));
    try {
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped).toMatchObject({ status: "cancelled", snapshot: { phase: "cancelled" } });
    } finally { baseline.resolve(); await first; }
    await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Next", provider: "codex", model: "gpt-5", permissionMode: "default" });
    await vi.waitFor(() => expect(fixture.sent.map((turn) => turn.message)).toEqual(["Next"]));
  });

  it("aborts an auto-resumed turn when a pending mutation reservation owns the thread", async () => {
    const fixture = await openFixture("claude");
    const mutationReservations = container.resolve(ThreadControlMutationReservationService);
    mutationReservations.rehydrate(fixture.thread.id, "pending-approval");

    await expect(fixture.host.turns.open({
      threadId: fixture.thread.id,
      notice: "Claude continued without a prompt",
    })).resolves.toEqual({ kind: "declined", reason: "busy" });

    await vi.waitFor(() => {
      expect(fixture.provider.stopSession).toHaveBeenCalledWith(`mcode-${fixture.thread.id}`);
    });
  });

  it("admits a replacement after cancelling delayed setup without dispatching the cancelled message", async () => {
    const fixture = await openFixture("claude");
    let releaseSetup!: () => void;
    const setupReady = new Promise<void>((resolve) => { releaseSetup = resolve; });
    const persist = vi.spyOn(container.resolve(AttachmentService), "persist").mockImplementationOnce(() => (
      setupReady.then(() => ({ stored: [], persisted: [] }))
    ));
    const send = fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "hello", permissionMode: "default",
      model: "claude-sonnet-4-6", attachments: [], provider: "claude",
    });
    try {
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped.status).toBe("cancelled");
      expect(stopped.dispatchState).toBe("not-dispatched");
      expect(fixture.sent).toEqual([]);
    } finally {
      releaseSetup();
      await send;
    }
    expect(fixture.sent).toEqual([]);

    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default",
      model: "claude-sonnet-4-6", attachments: [], provider: "claude",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((turn) => turn.message)).toEqual(["replacement"]);
  });

  it("finishes a parent start committed after a user stop before admitting a replacement", async () => {
    const fixture = await openFixture("claude");
    let releaseStart!: () => void;
    const startReady = new Promise<void>((resolve) => { releaseStart = resolve; });
    const owner = fixture.workers.owner;
    const startParent = owner.start.bind(owner);
    const start = vi.spyOn(owner, "start").mockImplementationOnce(async (input) => {
      await startReady;
      await startParent(input);
    });
    const send = fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "hello", permissionMode: "default",
      model: "claude-sonnet-4-6", attachments: [], provider: "claude",
    });
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      const stopped = await fixture.service.stopSession(fixture.thread.id, { by: "user" });
      expect(stopped.status).toBe("cancelled");
      expect(stopped.dispatchState).toBe("not-dispatched");
      expect(fixture.sent).toEqual([]);
    } finally {
      releaseStart();
      await send;
    }

    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default",
      model: "claude-sonnet-4-6", attachments: [], provider: "claude",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((turn) => turn.message)).toEqual(["replacement"]);
    const executionId = start.mock.calls[0]?.[0].execution.executionId;
    if (!executionId) throw new Error("Parent start did not receive an execution identity");
    const stoppedTurn = fixture.canonical.loadTurnByExecution(executionId);
    expect(stoppedTurn?.status).toBe("Cancelled");
    expect(stoppedTurn?.ending).toEqual({ outcome: "cancelled", stop: { by: "user" } });
  });

  it("redacts Browser tool input and output before persistence and publication", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      toolCallId: "browser-evaluate", toolName: "mcp__mcode__browser_evaluate",
      toolInput: { expression: "globalThis.BROWSER_INPUT_SECRET" } });
    await fixture.emit({ type: "toolResult", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      toolCallId: "browser-evaluate", output: '{"valueJson":"BROWSER_OUTPUT_SECRET"}', isError: false });
    await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId));
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });

    const durableEvents = fixture.db.query<{
      type: string;
      tool_input: string | null;
      output: string | null;
    }, [string]>(`
      SELECT json_extract(envelope_json, '$.payload.item.payload.runtimeEvent.event.type') AS type,
        json_extract(envelope_json, '$.payload.item.payload.runtimeEvent.event.toolInput') AS tool_input,
        json_extract(envelope_json, '$.payload.item.payload.runtimeEvent.event.output') AS output
      FROM canonical_agent_events
      WHERE execution_id = ?
        AND json_extract(envelope_json, '$.payload.item.payload.runtimeEvent.event.toolCallId') = 'browser-evaluate'
      ORDER BY accepted_sequence
    `).all(turn.turnExecutionId);
    expect.soft(durableEvents).toEqual([
      { type: "toolUse", tool_input: '{"operation":"browser_evaluate"}', output: null },
      { type: "toolResult", tool_input: null, output: '{"operation":"browser_evaluate","outcome":"completed"}' },
    ]);
    const publishedUse = fixture.published.find((event) => event.type === "toolUse" && event.toolCallId === "browser-evaluate");
    const publishedResult = fixture.published.find((event) => event.type === "toolResult" && event.toolCallId === "browser-evaluate");
    expect.soft(publishedUse).toHaveProperty("toolInput", { operation: "browser_evaluate" });
    expect.soft(publishedResult).toHaveProperty("output", '{"operation":"browser_evaluate","outcome":"completed"}');
  });

  it("keeps an automatic queued dispatch pending after an early provider send until Ended releases the active Turn", async () => {
    const fixture = await openFixture("claude");
    const providerSent = new Promise<void>((resolve) => {
      fixture.provider.sendTurn.mockImplementationOnce(async (turn) => {
        fixture.sent.push(turn);
        resolve();
      });
    });
    const message = await fixture.messages.create(fixture.thread.id, "user", "Queued work", 1);
    const accepted = await fixture.service.dispatchQueuedAutomaticTurn({
      threadId: fixture.thread.id, messageId: message.id, content: "Queued work", displayContent: "Queued work",
      model: "claude-sonnet-4-6", permissionMode: "default", attachments: [], persistedAttachments: [], mentions: [], provider: "claude",
    });
    expect(fixture.service.runtimeAccess().activeThreadIds()).toContain(fixture.thread.id);
    let completed = false;
    void accepted.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    await providerSent;
    expect(fixture.sent).toHaveLength(1);
    const turn = fixture.sent[0];
    if (!turn) throw new Error("Queued turn did not reach the provider");
    await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId, fixture.provider.id));
    expect(completed).toBe(false);
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    await expect(accepted.completion).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });

  it("retries page images from stored files exactly once after the original capture is deleted", async () => {
    const fixture = await openFixture("claude");
    const sourcePath = NodePath.join(fixture.directory, "page.png");
    const bytes = Buffer.from([137, 80, 78, 71]);
    await NodeFSPromises.writeFile(sourcePath, bytes);
    const capture = { schemaVersion: 2 as const, pageUrl: "https://www.google.com/", pageTitle: "Google",
      capturedAt: "2026-07-02T00:00:00.000Z", captureKind: "element" as const, selectorHint: "html",
      bounds: { x: 0, y: 0, width: 1280, height: 720 }, layoutViewport: { width: 1280, height: 720 } };
    const bundle: PreviewAnnotationBundle = { schemaVersion: 1, annotations: [{
      id: "550e8400-e29b-41d4-a716-446655440001", displayNumber: 1, pageIdentity: capture.pageUrl, pageContext: capture,
      targetContext: { label: "html", selectorHint: "html", bounds: capture.bounds }, note: "Move the header down.",
      snapshot: { id: "annotation-shot-1", name: "preview.png", mimeType: "image/png", sizeBytes: 4, sourcePath, capture },
    }] };
    await fixture.service.sendMessage({ threadId: fixture.thread.id, content: appendPreviewAnnotations("fix this", bundle),
      displayContent: "fix this", provider: "claude", previewAnnotations: bundle });
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(1));
    const original = fixture.sent[0];
    if (!original) throw new Error("Original turn was not dispatched");
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: original.turnExecutionId,
      error: "provider failed", failure: { kind: "fatal" } });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: original.turnExecutionId });
    expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined();
    await NodeFSPromises.unlink(sourcePath);
    const storage = new AttachmentService();
    const recovery = new TurnRecoveryService(fixture.canonical, fixture.threads, storage,
      container.resolve(ParentAssistantTextCheckpointService), container.resolve(ThreadStartupRepo), fixture.messages, fixture.providerRegistry);
    const providerSent = new Promise<void>((resolve) => {
      fixture.provider.sendTurn.mockImplementationOnce(async (turn) => {
        fixture.sent.push(turn);
        resolve();
      });
    });
    const retry = await recovery.retryErroredTurn({ threadId: fixture.thread.id, turnId: original.turnId }, (command) => sendRecoveryAttempt(fixture.service, command));
    await providerSent;
    expect(fixture.sent).toHaveLength(2);
    const message = fixture.canonical.loadUserMessage(retry.turnId);
    if (!message?.attachments || message.previewAnnotations?.schemaVersion !== 2) throw new Error("Missing v2 retry message");
    expect(message.attachments.map(({ name, sizeBytes }) => ({ name, sizeBytes }))).toEqual([{ name: "Notes on Google.png", sizeBytes: 4 }]);
    expect(message.previewAnnotations.pages[0]?.snapshot.id).toBe(message.attachments[0]!.id);
    const persisted = storage.prepareRetryAttachments(fixture.thread.id, message.attachments);
    expect(await NodeFSPromises.readFile(persisted[0]!.sourcePath)).toEqual(bytes);
    expect(fixture.provider.sendTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ name: "Notes on Google.png", sizeBytes: 4 })], message: expect.not.stringMatching(/"sourcePath"|"name"/),
    }));
  });

  it("waits for a provider terminal outcome during graceful stopAll", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const child = await spawnChild(fixture, turn.turnExecutionId, "shutdown");
    let releaseStop!: () => void;
    const stopReady = new Promise<void>((resolve) => { releaseStop = resolve; });
    let statusAtStop: string | undefined;
    fixture.provider.stopSession.mockImplementation(async () => {
      statusAtStop = fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status;
      await stopReady;
      await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" });
    });
    const stopping = fixture.service.stopAll();
    let completed = false;
    void stopping.then(() => { completed = true; });
    await vi.waitFor(() => expect(statusAtStop).toBe("Running"));
    expect(completed).toBe(false);
    releaseStop();
    await stopping;
    expect(completed).toBe(true);
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadCanonicalChildStopTarget({ owningParentThreadId: fixture.thread.id, childThreadId: child.childThread.id })?.latestTurn?.status).toBe("Interrupted");
    expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id);
    expect(fixture.provider.stopSession).toHaveBeenCalledWith(`mcode-${fixture.thread.id}`);
  });

  it("records a provider interruption during graceful stopAll as app_closed", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    fixture.provider.stopSession.mockImplementation(() => fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" }));
    await fixture.service.stopAll();
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "interrupted", cause: "app_closed" });
  });

  it("writes every accepted save queued behind a busy database when shutdown closes persistence", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const texts = Array.from({ length: 40 }, (_, index) => `received text ${index}. `);
    const lock = new Database(NodePath.join(fixture.directory, "app.sqlite"));
    lock.run("BEGIN IMMEDIATE");
    const emitted = Promise.allSettled(texts.map((delta) => fixture.emit({ type: "textDelta", threadId: fixture.thread.id,
      turnExecutionId: turn.turnExecutionId, delta })));
    try {
      await vi.waitFor(() => expect(fixture.deliveredCount()).toBe(texts.length));
      const closing = fixture.workers.close();
      lock.run("ROLLBACK");
      await closing;
    } finally {
      if (lock.inTransaction) lock.run("ROLLBACK");
      lock.close();
    }
    await emitted;
    const restarted = await restart(fixture);
    expect(await container.resolve(TurnRecoveryService).reconcileOnStartup()).toEqual({ interrupted: [turn.turnExecutionId] });
    expect(restarted.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "app_closed" },
    });
    expect(restarted.assistant()).toMatchObject({ content: texts.join(""), outcome: "interrupted" });
  });

  it("saves provider-queued text and its real end that a blocked delivery holds when shutdown starts", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const releaseDeliveries = fixture.holdDeliveries();
    const queued = Promise.allSettled([
      fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
        content: "text the provider received before shutdown", tokens: null }),
      fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId)),
      fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId }),
    ]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = fixture.service.stopAll();
    try {
      await vi.waitFor(() => expect(fixture.provider.stopSession).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(SLOW_PROVIDER_MS);
      releaseDeliveries();
      await vi.waitFor(() => expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed"),
        { timeout: 5_000 });
    } finally {
      vi.useRealTimers();
      releaseDeliveries();
    }
    await stopping;
    await queued;
    expect(fixture.assistant()).toMatchObject({ content: "text the provider received before shutdown", outcome: "completed" });
  });

  it("saves the provider's real end that arrives while its stop still hangs", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    fixture.provider.stopSession.mockImplementation(() => new Promise<void>(() => {
      setTimeout(() => {
        void fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
          content: "finished answer", tokens: null })
          .then(() => fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId)))
          .then(() => fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId }));
      }, SLOW_PROVIDER_MS);
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = fixture.service.stopAll();
    try {
      await vi.waitFor(() => expect(fixture.provider.stopSession).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(SLOW_PROVIDER_MS);
      await vi.waitFor(() => expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed"),
        { timeout: 5_000 });
      // The hung stop still has to time out before stopAll returns.
      await vi.advanceTimersByTimeAsync(SERVER_SHUTDOWN_DEADLINE_MS);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
    expect(fixture.assistant()).toMatchObject({ content: "finished answer", outcome: "completed" });
  });

  it("closes turn persistence before the watchdog when agent stop and provider teardown hang", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      content: "partial answer before shutdown", tokens: null });
    const hang = () => new Promise<void>(() => undefined);
    const descendants = vi.spyOn(SubagentRosterService.prototype, "stopDescendants").mockImplementation(hang);
    fixture.provider.stopSession.mockImplementation(hang);
    vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementation(hang);
    const sessions = new SessionRuntime({ spawn: async () => ({ state: {}, pids: [] }), isBusy: () => false,
      interrupt: async () => undefined, close: hang, isStale: () => false }, {
      jobObject: { isWindowsJob: false, assign: () => true, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    await sessions.acquire({ sessionId: "hanging-adapter", threadId: fixture.thread.id, cwd: fixture.directory, permissionMode: "default" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let watchdogExpired = false;
    setTimeout(() => { watchdogExpired = true; }, SERVER_SHUTDOWN_DEADLINE_MS);
    let persistedInTime: boolean | undefined;
    const shutdown = runShutdownPhases({
      stopServices: async () => {
        await fixture.service.stopAll();
        await sessions.shutdown();
      },
      persist: (saveAttemptsUntil) => fixture.workers.close({ attemptsUntil: saveAttemptsUntil }),
      onServicesOverrun: () => undefined,
    }).then(() => { persistedInTime = !watchdogExpired; });
    try {
      await vi.waitFor(() => expect(descendants).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(SHUTDOWN_PERSISTENCE_START_MS);
      await vi.waitFor(() => expect(persistedInTime !== undefined || watchdogExpired).toBe(true), { timeout: 10_000 });
    } finally {
      vi.useRealTimers();
    }
    expect(persistedInTime).toBe(true);
    await shutdown;
    const restarted = await restart(fixture);
    expect(await container.resolve(TurnRecoveryService).reconcileOnStartup()).toEqual({ interrupted: [turn.turnExecutionId] });
    expect(restarted.assistant()).toMatchObject({ content: "partial answer before shutdown", outcome: "interrupted" });
  });

  it("settles a turn a previous process left Running when the server starts again", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      content: "partial answer before the crash", tokens: null });
    const restarted = await restart(fixture);
    expect(restarted.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Running");

    expect(await container.resolve(TurnRecoveryService).reconcileOnStartup()).toEqual({ interrupted: [turn.turnExecutionId] });

    expect(restarted.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "app_closed" },
    });
    expect(restarted.assistant()).toMatchObject({ content: "partial answer before the crash", outcome: "interrupted" });
    expect(restarted.threads.findById(restarted.thread.id)?.status).toBe("interrupted");
  });

  it.each([true, false])("records shutdown execution state with provider terminal=%s", async (terminal) => {
    const dir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-stopall-"));
    diag.configure({ dir, enabled: true });
    try {
      const fixture = await openFixture();
      const turn = await sendTurn(fixture);
      if (terminal) fixture.provider.stopSession.mockImplementation(() => fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" }));
      await fixture.service.stopAll();
      diag.flushSync();
      // flushSync leaves in-flight appends running and may rewrite their batch, so a record can land
      // twice; its sequence stamp identifies it and defines recording order.
      await vi.waitFor(async () => {
        const file = NodePath.join(dir, "t", `${threadRecordingFileId(fixture.thread.id, diag.runId)}.jsonl`);
        const recording = await NodeFSPromises.readFile(file, "utf8");
        const bySequence = new Map(recording.split("\n").map(parseDiagLine)
          .filter((row) => row !== undefined).map((row) => [row.n, row] as const));
        const records = [...bySequence.values()].sort((a, b) => a.n - b.n);
        const stops = records.filter((row) => row.ch === "agent.stop");
        expect(stops.map((row) => row.k)).toEqual(["beg", "end"]);
        expect(stops[0].d).toMatchObject({ by: "shutdown", provider: "codex" });
        expect(records.filter((row) => row.ch === "agent.stopped").map((row) => row.d)).toEqual([{
          execution: turn.turnExecutionId, turn: fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.id,
          phase: terminal ? "interrupted" : "running", terminal,
        }]);
      });
    } finally {
      diag.configure({ enabled: false });
      await NodeFSPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it("ends an exact provider_lost turn Interrupted and releases it", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      content: "partial answer before stream loss", tokens: null });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined();
    expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id);
    expect(fixture.service.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, phase: "interrupted",
    }));
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "interrupted", cause: "provider_exited" });
    expect(fixture.canonical.loadCheckpoint(turn.turnExecutionId)).toMatchObject({ phase: "finalized", terminalOutcome: "interrupted" });
    expect(fixture.threads.findById(fixture.thread.id)?.status).toBe("interrupted");
    expect(fixture.assistant()).toMatchObject({ content: "partial answer before stream loss", outcome: "interrupted", outcomeExecutionId: turn.turnExecutionId });
    expect(fixture.published).toContainEqual(expect.objectContaining({ type: "ended", turnExecutionId: turn.turnExecutionId, reason: "provider_lost" }));
    expect(fixture.published.find((event) => event.type === "ended" && event.reason === "provider_lost")).not.toHaveProperty("outcome");
    expect(fixture.published).toContainEqual(expect.objectContaining({ type: "ended", turnExecutionId: turn.turnExecutionId, outcome: "interrupted" }));
    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
  });

  it("ends a Claude turn Interrupted when its stream is lost before its reply text is classified", async () => {
    const fixture = await openFixture("claude");
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, delta: "partial reply" });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "interrupted", cause: "provider_exited" });
    expect(fixture.threads.findById(fixture.thread.id)?.status).toBe("interrupted");
    expect(fixture.assistant()).toMatchObject({ content: "partial reply", outcome: "interrupted", outcomeExecutionId: turn.turnExecutionId });
  });

  it("ends a provider_lost turn during graceful stopAll with app_closed", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    let releaseFence!: () => void;
    const fenceReady = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fence = vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementation(() => fenceReady);
    fixture.provider.stopSession.mockImplementation(() => fixture.emit({
      type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost",
    }));
    const stopping = fixture.service.stopAll();
    let completed = false;
    void stopping.then(() => { completed = true; });
    try {
      await vi.waitFor(() => expect(fence).toHaveBeenCalled());
      expect(completed).toBe(false);
    } finally {
      releaseFence();
      await stopping;
    }
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "app_closed" },
    });
  });

  it("a stop arriving during a lost-stream finish joins it", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    let releaseFence!: () => void;
    const fenceReady = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fence = vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(() => fenceReady);
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(1));
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
    try {
      releaseFence();
      expect(await stopping).toMatchObject({ status: "already-terminal", snapshot: { phase: "interrupted", turnExecutionId: turn.turnExecutionId } });
    } finally {
      releaseFence();
    }
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "provider_exited" },
    });
    expect(fixture.canonicalEvents.filter((event) => event.routing.executionId === turn.turnExecutionId
      && event.payload.type === "turn.interrupted")).toHaveLength(1);
    expect(fixture.published.filter((event) => event.type === "ended" && event.turnExecutionId === turn.turnExecutionId
      && event.outcome !== undefined)).toEqual([expect.objectContaining({ outcome: "interrupted" })]);
  });

  describe("a stop arriving while a failed provider start is being recorded", () => {
    const dispatchError = "Injected provider dispatch failure";

    /** Resolves once Stop has looked up the worker turn, which is where it picks its path synchronously. */
    function watchStopDecision(fixture: WorkerFixture) {
      const decided = holdDeferred();
      const current = fixture.workers.owner.current.bind(fixture.workers.owner);
      vi.spyOn(fixture.workers.owner, "current").mockImplementation((threadId) => {
        decided.resolve();
        return current(threadId);
      });
      return decided.promise;
    }

    async function expectErroredAndReusable(fixture: WorkerFixture, stopping: Promise<unknown>) {
      await expect(stopping).resolves.toMatchObject({ status: "already-terminal", snapshot: { phase: "errored" } });
      await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
      const turn = fixture.sent[0];
      if (!turn) throw new Error("Provider did not receive the turn");
      expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
        status: "Errored",
        ending: { outcome: "errored", failure: expect.objectContaining({ provider: "codex", message: dispatchError }) },
      });
      await expect(fixture.service.sendMessage({
        threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
      })).resolves.toBeUndefined();
      expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
    }

    function failNextProviderStart(fixture: WorkerFixture) {
      fixture.provider.sendTurn.mockImplementationOnce(async (turn) => {
        fixture.sent.push(turn);
        throw new Error(dispatchError);
      });
    }

    it("resolves a failed start's file evidence instead of leaving it checking", async () => {
      const fixture = await openFixture();
      const snapshots = container.resolve(SnapshotService);
      vi.spyOn(snapshots, "captureRef").mockResolvedValue("a".repeat(40));
      const ledger = new TurnFileEvidenceLedger(fixture.db, fixture.writer, snapshots);
      container.resolve(TurnRuntimeController).bindFileEvidence(ledger);
      bindTurnFileEvidenceLedger(ledger);
      failNextProviderStart(fixture);
      try {
        await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work",
          provider: "codex", model: "gpt-5", permissionMode: "default" });
        await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
        await vi.waitFor(() => expect(listTurnFileEvidence(fixture.db, { threadId: fixture.thread.id })[0]?.evidence).toMatchObject({ state: "recorded" }));
      } finally { ledger.close(); }
    });

    it("keeps the Errored outcome when Stop arrives while the failure fences provider events", async () => {
      const fixture = await openFixture();
      failNextProviderStart(fixture);
      const fenceEntered = holdDeferred();
      const releaseFence = holdDeferred();
      vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(async () => {
        fenceEntered.resolve();
        await releaseFence.promise;
      });
      const sending = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work",
        provider: "codex", model: "gpt-5", permissionMode: "default" });
      await fenceEntered.promise;
      const decided = watchStopDecision(fixture);
      const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
      try {
        await decided;
      } finally {
        releaseFence.resolve();
      }
      await sending;
      await expectErroredAndReusable(fixture, stopping);
    });

    it("keeps the Errored outcome when Stop arrives after the failure commits but before the runtime reads it", async () => {
      const fixture = await openFixture();
      failNextProviderStart(fixture);
      const committed = holdDeferred();
      const releaseReply = holdDeferred();
      const submit = fixture.workers.owner.submit.bind(fixture.workers.owner);
      vi.spyOn(fixture.workers.owner, "submit").mockImplementation(async (execution, command) => {
        const reply = await submit(execution, command);
        if (command.kind === "finish-from-state") {
          committed.resolve();
          await releaseReply.promise;
        }
        return reply;
      });
      const sending = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work",
        provider: "codex", model: "gpt-5", permissionMode: "default" });
      await committed.promise;
      const decided = watchStopDecision(fixture);
      const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
      try {
        await decided;
      } finally {
        releaseReply.resolve();
      }
      await sending;
      await expectErroredAndReusable(fixture, stopping);
    });

    it("waits for recovery when recording the failure itself fails, and the send still reports the provider's reason", async () => {
      const fixture = await openFixture();
      failNextProviderStart(fixture);
      const fenceEntered = holdDeferred();
      const releaseFence = holdDeferred();
      vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(async () => {
        fenceEntered.resolve();
        await releaseFence.promise;
        throw new Error("Injected provider fence failure");
      });
      // Settle both results up front so a rejection is asserted below rather than reported as unhandled.
      const sendResult = fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Do the work",
        provider: "codex", model: "gpt-5", permissionMode: "default" }).then(() => "sent", (error: unknown) => String(error));
      await fenceEntered.promise;
      const decided = watchStopDecision(fixture);
      const stopResult = fixture.service.stopSession(fixture.thread.id, { by: "user" })
        .then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
      try {
        await decided;
      } finally {
        releaseFence.resolve();
      }
      expect(await stopResult).toEqual({ value: expect.objectContaining({ status: "already-terminal",
        snapshot: expect.objectContaining({ phase: "interrupted" }) }) });
      // The saved interruption cannot say why the start failed, so the send reports the provider's reason.
      expect(await sendResult).toContain(dispatchError);
      await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
      const turn = fixture.sent[0];
      if (!turn) throw new Error("Provider did not receive the turn");
      expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
        status: "Interrupted", ending: { outcome: "interrupted", cause: "saving_stopped" },
      });
      await expect(fixture.service.sendMessage({
        threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
      })).resolves.toBeUndefined();
      expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
    });
  });

  it("reports the provider's own ending when it commits while a user stop drains the turn", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    let releaseFence!: () => void;
    const fenceReady = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fence = vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(() => fenceReady);
    const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
    try {
      await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(1));
      await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId));
      await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    } finally {
      releaseFence();
    }

    expect(await stopping).toMatchObject({ status: "already-terminal",
      snapshot: { phase: "completed", turnExecutionId: turn.turnExecutionId } });
  });

  it("recovers a failed lost-stream drain and admits a replacement", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const recover = vi.spyOn(fixture.workers, "recoverRejected");
    const reported = vi.spyOn(logger, "error");
    const fenceError = new Error("Provider fence failed");
    vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockRejectedValueOnce(fenceError);
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id,
      turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined();
    // The saved ending carries no message, so the log is where the fence failure must surface as the cause.
    expect(reported).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      executionId: turn.turnExecutionId, error: fenceError.message,
    }));
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ executionId: turn.turnExecutionId }));
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "saving_stopped" },
    });
    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
  });

  it("recovers a failed lost-stream release, keeps the committed ending, and lets Stop report it", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const waitForRelease = captureTurnRelease(fixture);
    const recover = vi.spyOn(fixture.workers, "recoverRejected");
    const releaseError = new Error("Provider retirement failed");
    let releaseRetirement!: () => void;
    const retirementReady = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const retire = vi.spyOn(fixture.provider, "retireCanonicalTurnEvents").mockImplementationOnce(async () => {
      await retirementReady;
      throw releaseError;
    });
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    try {
      await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
      const stopping = expect(fixture.service.stopSession(fixture.thread.id, { by: "user" }))
        .resolves.toMatchObject({ status: "already-terminal", snapshot: { phase: "interrupted" } });
      releaseRetirement();
      await stopping;
    } finally {
      releaseRetirement();
    }
    await waitForRelease();
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ executionId: turn.turnExecutionId }));
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)).toMatchObject({
      status: "Interrupted", ending: { outcome: "interrupted", cause: "provider_exited" },
    });
    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
  });

  it("keeps a provider terminal committed during the lost-stream drain", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const waitForRelease = captureTurnRelease(fixture);
    const recover = vi.spyOn(fixture.workers, "recoverRejected");
    let releaseFence!: () => void;
    const fenceReady = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fence = vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(() => fenceReady);
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(1));
    try {
      await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId));
      await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "completed" });
    } finally {
      releaseFence();
    }
    await waitForRelease();
    expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined();
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Completed");
    expect(recover).not.toHaveBeenCalled();
    expect(fixture.published.filter((event) => event.type === "ended" && event.turnExecutionId === turn.turnExecutionId
      && event.outcome !== undefined)).toEqual([expect.objectContaining({ outcome: "completed" })]);
  });

  it("keeps a user stop in control when the provider emits an outcome-less provider_lost Ended", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    let releaseFence!: () => void;
    const fenceReady = new Promise<void>((resolve) => { releaseFence = resolve; });
    let ended!: () => void;
    const endedReady = new Promise<void>((resolve) => { ended = resolve; });
    vi.spyOn(fixture.provider, "fenceCanonicalTurnEvents").mockImplementationOnce(() => fenceReady);
    const retire = vi.spyOn(fixture.provider, "retireCanonicalTurnEvents");
    const releaseRecovered = vi.spyOn(fixture.workers.owner, "releaseRecovered");
    fixture.provider.stopSession.mockImplementation(async () => {
      try {
        await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
      } finally {
        ended();
      }
    });
    const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
    try {
      await endedReady;
    } finally {
      releaseFence();
    }
    expect((await stopping).status).toBe("cancelled");
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "cancelled", stop: { by: "user" } });
    fixture.provider.stopSession.mockResolvedValue(undefined);
    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
    expect(releaseRecovered).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("keeps raw teardown Ended from the evicted pooled session from ending the replacement turn", async () => {
    const fixture = await openFixture();
    const previous = await sendTurn(fixture);
    await fixture.emit(turnComplete(fixture.thread.id, previous.turnExecutionId));
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: previous.turnExecutionId });
    expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined();
    const publication = container.resolve(AgentEventPublicationRegistry);
    Object.assign(fixture.provider, {
      discardSession: async () => {
        publication.publish({ type: "ended", threadId: fixture.thread.id,
          turnExecutionId: previous.turnExecutionId, outcome: "completed" });
        await publication.drain();
        expect(fixture.threads.findById(fixture.thread.id)?.status).toBe("active");
      },
    });

    await fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default",
      model: "gpt-5", provider: "codex", forceFreshSession: true,
    });

    const replacement = fixture.sent.at(-1);
    if (!replacement) throw new Error("Provider did not receive the replacement turn");
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
    expect(fixture.service.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: fixture.thread.id, turnExecutionId: replacement.turnExecutionId, phase: "running",
    }));
    expect(fixture.canonical.loadTurnByExecution(replacement.turnExecutionId)?.status).toBe("Running");
    await fixture.emit(turnComplete(fixture.thread.id, replacement.turnExecutionId));
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: replacement.turnExecutionId });
    expect(fixture.canonical.loadTurnByExecution(replacement.turnExecutionId)?.status).toBe("Completed");
  });

  it("publishes a cancelled Ended that matches the stored turn when the user stops", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.service.stopSession(fixture.thread.id, { by: "user" });
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.published).toContainEqual(expect.objectContaining({
      type: "ended", turnExecutionId: turn.turnExecutionId, outcome: "cancelled",
    }));
    const storedTurn = fixture.canonical.loadTurnByExecution(turn.turnExecutionId);
    expect(storedTurn?.status).toBe("Cancelled");
    expect(storedTurn?.ending).toEqual({ outcome: "cancelled", stop: { by: "user" } });
  });

  it("maps provider-cancelled Ended to the recoverable interrupted outcome", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" });
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending)
      .toEqual({ outcome: "interrupted", cause: "provider_exited" });
    expect(fixture.threads.findById(fixture.thread.id)?.status).toBe("interrupted");
    expect(broadcast).toHaveBeenCalledWith("thread.status", { threadId: fixture.thread.id, status: "interrupted" });
  });

  it.each([
    [{ by: "user" }, { by: "mcode", reason: "approval_unanswerable" }],
    [{ by: "mcode", reason: "approval_unanswerable" }, { by: "user" }],
  ] as const)("records the first stop cause when two stops race (%o first)", async (first, second) => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    fixture.provider.stopSession.mockImplementation(() => fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId }));
    await Promise.all([fixture.service.stopSession(fixture.thread.id, first), fixture.service.stopSession(fixture.thread.id, second)]);
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "cancelled", stop: first });
  });

  it("keeps a provider Error consistent across the canonical turn, the message projection, and renderer state", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, content: "partial answer before failure", tokens: null });
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, error: "provider failed", failure: { kind: "fatal", status: 500, code: "internal_error" } });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Errored");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({
      outcome: "errored", failure: { kind: "fatal", provider: "codex", message: "provider failed", status: 500, code: "internal_error" },
    });
    const assistant = fixture.assistant();
    expect(assistant).toMatchObject({ outcome: "errored", outcomeExecutionId: turn.turnExecutionId });
    expect(fixture.canonical.loadConversationProjection(fixture.thread.id, 10).messages).toContainEqual(expect.objectContaining({ id: assistant?.id, outcome: "errored" }));
    expect(reduceAgentEventBatch(createAgentModelState(), fixture.canonicalEvents)).toMatchObject({ outcome: "applied", state: {
      turns: { [turn.turnId]: expect.objectContaining({ status: "Errored" }) },
    } });
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({ threadId: fixture.thread.id, messageId: assistant?.id, outcome: "errored", executionId: turn.turnExecutionId }));
  });

  it("publishes one transient provider Error and durably ends the worker turn errored", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId,
      error: "Provider connection failed: ECONNRESET", failure: { kind: "retryable" } });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id);

    expect(fixture.published.filter((event) => event.type === "error" && event.turnExecutionId === turn.turnExecutionId)).toHaveLength(1);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Errored");
  });

  it("ends a provider usage limit as an interruption that keeps the absolute reset time", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const acceptedNoEarlierThan = Date.now();
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, error: "You've hit your usage limit",
      failure: { kind: "usage_limit", status: 429, retryAfterMs: 60_000, limitType: "five_hour" } });
    await endTurn(fixture, { type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    const acceptedNoLaterThan = Date.now();
    const durable = fixture.canonical.loadTurnByExecution(turn.turnExecutionId);
    expect(durable?.status).toBe("Interrupted");
    expect(durable?.ending).toEqual({
      outcome: "interrupted",
      cause: "usage_limit",
      usageLimit: { resetsAt: expect.any(String), limitType: "five_hour" },
    });
    const resetsAt = durable?.ending?.outcome === "interrupted" ? Date.parse(durable.ending.usageLimit?.resetsAt ?? "") : Number.NaN;
    expect(resetsAt).toBeGreaterThanOrEqual(acceptedNoEarlierThan + 60_000);
    expect(resetsAt).toBeLessThanOrEqual(acceptedNoLaterThan + 60_000);
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({ threadId: fixture.thread.id, outcome: "interrupted", executionId: turn.turnExecutionId }));
    expect(broadcast).toHaveBeenCalledWith("thread.status", { threadId: fixture.thread.id, status: "interrupted" });
  });
});
