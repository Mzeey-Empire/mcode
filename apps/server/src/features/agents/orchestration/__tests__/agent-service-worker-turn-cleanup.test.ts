import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { container } from "tsyringe";
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

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
  vi.restoreAllMocks();
});

describe("AgentService cleanup through production worker composition", { timeout: 30_000 }, () => {
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
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });

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
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(1));
    const turn = fixture.sent[0];
    if (!turn) throw new Error("Queued turn did not reach the provider");
    await fixture.emit(turnComplete(fixture.thread.id, turn.turnExecutionId, fixture.provider.id));
    expect(completed).toBe(false);
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
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
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: original.turnExecutionId });
    await vi.waitFor(() => expect(fixture.workers.owner.current(fixture.thread.id)).toBeUndefined());
    await NodeFSPromises.unlink(sourcePath);
    const storage = new AttachmentService();
    const recovery = new TurnRecoveryService(fixture.canonical, fixture.threads, storage,
      container.resolve(ParentAssistantTextCheckpointService), container.resolve(ThreadStartupRepo), fixture.messages, fixture.providerRegistry);
    const retry = await recovery.retryErroredTurn({ threadId: fixture.thread.id, turnId: original.turnId }, (command) => sendRecoveryAttempt(fixture.service, command));
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(2));
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
    await vi.waitFor(() => expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted"));
    expect(fixture.canonical.loadCanonicalChildStopTarget({ owningParentThreadId: fixture.thread.id, childThreadId: child.childThread.id })?.latestTurn?.status).toBe("Interrupted");
    expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id);
    expect(fixture.provider.stopSession).toHaveBeenCalledWith(`mcode-${fixture.thread.id}`);
  });

  it("records a provider interruption during graceful stopAll as app_closed", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    fixture.provider.stopSession.mockImplementation(() => fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" }));
    await fixture.service.stopAll();
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Interrupted");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "interrupted", cause: "app_closed" });
  });

  it("releases an exact provider_lost Ended without terminalizing its durable turn", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
    await vi.waitFor(() => expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id));
    expect(fixture.service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === fixture.thread.id)).toBeUndefined();
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Running");
    expect(fixture.canonical.loadCheckpoint(turn.turnExecutionId)).toMatchObject({ phase: "running", terminalOutcome: null });
    expect(fixture.threads.findById(fixture.thread.id)?.status).toBe("active");
    expect(fixture.published).toContainEqual(expect.objectContaining({ type: "ended", turnExecutionId: turn.turnExecutionId, reason: "provider_lost" }));
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
    fixture.provider.stopSession.mockImplementation(async () => {
      try {
        await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, reason: "provider_lost" });
      } finally {
        ended();
      }
    });
    const stopping = fixture.service.stopSession(fixture.thread.id, { by: "user" });
    let retiredDuringStop: number;
    try {
      await endedReady;
      // Let the accepted Ended's deferred release run while Stop still owns its fence.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      retiredDuringStop = retire.mock.calls.length;
    } finally {
      releaseFence();
    }
    expect((await stopping).status).toBe("cancelled");
    await fixture.workers.progress?.waitForTerminalSaves(fixture.thread.id);
    expect(retiredDuringStop).toBe(0);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled");
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "cancelled", stop: { by: "user" } });
    fixture.provider.stopSession.mockResolvedValue(undefined);
    await expect(fixture.service.sendMessage({
      threadId: fixture.thread.id, content: "replacement", permissionMode: "default", model: "gpt-5", provider: "codex",
    })).resolves.toBeUndefined();
    expect(fixture.sent.map((sent) => sent.message)).toEqual(["Do the work", "replacement"]);
  });

  it("maps provider-cancelled Ended to the recoverable interrupted outcome", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, outcome: "cancelled" });
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
    await vi.waitFor(() => expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Cancelled"));
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.ending).toEqual({ outcome: "cancelled", stop: first });
  });

  it("keeps a provider Error consistent across the canonical turn, the message projection, and renderer state", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    await fixture.emit({ type: "message", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, content: "partial answer before failure", tokens: null });
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, error: "provider failed", failure: { kind: "fatal", status: 500, code: "internal_error" } });
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
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
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
    await vi.waitFor(() => expect(fixture.service.runtimeAccess().activeThreadIds()).not.toContain(fixture.thread.id));

    expect(fixture.published.filter((event) => event.type === "error" && event.turnExecutionId === turn.turnExecutionId)).toHaveLength(1);
    expect(fixture.canonical.loadTurnByExecution(turn.turnExecutionId)?.status).toBe("Errored");
  });

  it("ends a provider usage limit as an interruption that keeps the absolute reset time", async () => {
    const fixture = await openFixture();
    const turn = await sendTurn(fixture);
    const acceptedNoEarlierThan = Date.now();
    await fixture.emit({ type: "error", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId, error: "You've hit your usage limit",
      failure: { kind: "usage_limit", status: 429, retryAfterMs: 60_000, limitType: "five_hour" } });
    await fixture.emit({ type: "ended", threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId });
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
