import { AgentEventSchema, ProviderRuntimeEventSchema, type AgentEvent } from "@mcode/contracts";
import type { ProviderEventDraft } from "@mcode/providers";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionWorkerHandler, type ExecutionSemanticOperation, type ExecutionSemanticWriter,
  type ExecutionWorkCommand, type ExecutionWriteReceipt } from "../execution-worker-handler.js";
import { TurnFileTracker } from "../../turns/turn-file-tracker.js";

const execution = { threadId: "thread", turnId: "turn", executionId: "11111111-1111-4111-8111-111111111111" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "lease-1" };
const now = "2026-09-25T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => NodeFSPromises.rm(path, { recursive: true, force: true })));
});

async function fileFixture() {
  const cwd = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-handler-files-"));
  directories.push(cwd);
  const tracker = new TurnFileTracker(async () => ({ kind: "unavailable" }), () => {}, process.platform);
  const handoff = tracker.beginExecutionTurn({ ...execution, cwd, baselineRef: null });
  return { cwd, tracker, handoff };
}

function eventDraft(sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}): ProviderEventDraft {
  const event = AgentEventSchema().parse({ type, threadId: execution.threadId, turnExecutionId: execution.executionId, ...fields });
  const itemId = `item-${sequence}`;
  return { eventId: `event-${sequence}`, routing: { ...execution, itemId }, sourceProviderId: "codex", sourceIdentities: [],
    sourceSequence: sequence, payload: { type: "item.recorded", item: {
      id: itemId, threadId: execution.threadId, turnId: execution.turnId, kind: "system", providerIdentities: [],
      payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: now, updatedAt: now,
    } } };
}

function start(): Extract<ExecutionWorkCommand, { kind: "start" }> {
  return { kind: "start", providerId: "codex", parentLive: { planFeature: "none", precedingMessageId: "user" },
    input: { thread: { id: execution.threadId, workspaceId: "workspace", providerId: "codex", createdAt: now },
      turnId: execution.turnId, executionId: execution.executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: "user", content: "Task", sequence: 1 } } };
}

class Writer implements ExecutionSemanticWriter {
  readonly operations: ExecutionSemanticOperation[] = [];
  fail = false;
  throwFailure = false;
  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    this.operations.push(operation);
    if (this.throwFailure) throw new Error("writer disconnected");
    return this.fail ? { kind: "conflict", operationId: operation.operationId }
      : { kind: "committed", operationId: operation.operationId, durableRevision: this.operations.length };
  }
}

function fixture() {
  const writer = new Writer();
  const handler = new ExecutionWorkerHandler(writer);
  const send = (ordinal: number, command: ExecutionWorkCommand) => handler.handle({ requestId: ordinal, execution, lease, ordinal, command });
  const event = (ordinal: number, draft: ProviderEventDraft) => send(ordinal, {
    kind: "event", phase: "running", nativeCursor: null, events: [draft],
  });
  const stop = (ordinal: number) => handler.handle({ requestId: ordinal, execution, lease, ordinal,
    stopWatermark: ordinal - 1, command: { kind: "stop", requestId: "user-stop" } });
  return { writer, send, event, stop };
}

describe("execution worker parent event ownership", () => {
  it.each(["codex", "claude", "cursor"] as const)("preserves %s partial text and narrative when Stop finishes from worker state", async (providerId) => {
    const { writer, send, event, stop } = fixture();
    const command = start();
    await send(1, { ...command, providerId, input: { ...command.input, thread: { ...command.input.thread, providerId } } });
    const draft = (sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}) => ({
      ...eventDraft(sequence, type, fields), sourceProviderId: providerId,
    });
    await event(2, draft(1, "turnStarted"));
    await event(3, draft(2, "textDelta", { delta: "Checking files", isFinalResponse: false }));
    await event(4, draft(3, "textDelta", { delta: "Partial unclassified answer" }));
    expect((await stop(5)).result.kind).toBe("committed");
    const reply = await send(6, { kind: "finish-from-state", outcome: "cancelled",
      input: { ...execution, providerId, providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" } } });
    expect(reply.result.kind).toBe("committed");
    expect(writer.operations).toHaveLength(6);
    expect(writer.operations[5]).toMatchObject({ mutation: { kind: "finish-live-event", outcome: "cancelled",
      projection: { assistant: { content: "Partial unclassified answer" }, narrative: [
        expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ text: "Checking files" }) }),
      ] } }, livePublication: [{ after: "terminal", event: { type: "ended", outcome: "interrupted" } }] });
    expect(writer.operations[5]?.mutation).not.toHaveProperty("providerEvent");
    expect((await send(7, { kind: "release" })).result).toEqual({ kind: "released" });
  });

  it("finishes a setup error before turnStarted without losing the admitted execution", async () => {
    const { writer, send } = fixture();
    await send(1, start());
    const input = { ...execution, providerId: "codex", providerIdentities: [], outcome: "errored", projection: { kind: "writer-staged" } } as const;
    expect((await send(2, { kind: "finish-from-state", outcome: "errored", input })).result.kind).toBe("rejected");
    const reply = await send(2, { kind: "finish-from-state", outcome: "errored", input: { ...input, error: "Provider executable missing" } });
    expect(reply.result.kind).toBe("committed");
    expect(writer.operations).toHaveLength(2);
    expect(writer.operations[1]).toMatchObject({ mutation: { kind: "finish-live-event", outcome: "errored",
      projection: { assistant: { content: "" }, narrative: [] } },
      livePublication: [{ event: { type: "error", error: "Provider executable missing" } }],
    });
  });

  it("settles captured edits on the worker before its single terminal writer call", async () => {
    const { cwd, tracker, handoff } = await fileFixture();
    const { writer, send } = fixture();
    const file = NodePath.join(cwd, "tracked.txt");
    await NodeFSPromises.writeFile(file, "before\n");
    await send(1, start());
    expect((await send(2, { kind: "begin-files", cwd, handoff, deliveryAttempt: 1 })).result.kind).toBe("committed");
    const command = (draft: ProviderEventDraft): Extract<ExecutionWorkCommand, { kind: "event" }> => ({
      kind: "event", phase: "running", nativeCursor: null, deliveryAttempt: 1, events: [draft],
    });
    await send(3, command(eventDraft(1, "turnStarted")));
    const toolInput = { file_path: "tracked.txt" };
    const captured = tracker.captureToolUseObservation(execution.threadId, "edit", "Edit", toolInput);
    if (!captured) throw new Error("Expected captured file evidence");
    await NodeFSPromises.writeFile(file, "after\nextra\n");
    const use = eventDraft(2, "toolUse", { toolCallId: "edit", toolName: "Edit", toolInput });
    expect((await send(4, { ...command(use), capturedFileObservation: captured })).result.kind).toBe("committed");
    expect((await send(5, command(eventDraft(3, "toolResult", { toolCallId: "edit", output: "Done", isError: false })))).result.kind).toBe("committed");
    const terminal = eventDraft(4, "error", { error: "Disconnected" });
    const reply = await send(6, { ...command(terminal),
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "errored", projection: { kind: "writer-staged" } },
      frozenFileEvidence: { handoff, turnId: execution.turnId, deliveryAttempt: 1, outcome: "errored", nativeDiff: null } });
    expect(reply.result.kind).toBe("committed");
    expect(writer.operations).toHaveLength(6);
    expect(writer.operations[5]?.mutation).toMatchObject({ kind: "finish-live-event", input: {
      error: "Disconnected", fileEvidence: { filesChanged: ["tracked.txt"], fileEffects: { fileCount: 1, additions: 2, deletions: 1 } },
    } });
    expect((await send(7, { kind: "release" })).result).toEqual({ kind: "released" });
  });

  it("fences attempts and poisons a terminal whose file evidence is missing", async () => {
    const { cwd, handoff } = await fileFixture();
    const { writer, send } = fixture();
    await send(1, start());
    await send(2, { kind: "begin-files", cwd, handoff, deliveryAttempt: 1 });
    const started = { kind: "event", phase: "running", nativeCursor: null, events: [eventDraft(1, "turnStarted")] } satisfies ExecutionWorkCommand;
    expect((await send(3, { ...started, deliveryAttempt: 2 })).result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect((await send(3, { ...started, deliveryAttempt: 1 })).result.kind).toBe("committed");
    const terminal = { ...started, events: [eventDraft(2, "error", { error: "Disconnected" })], deliveryAttempt: 1,
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "errored", projection: { kind: "writer-staged" } },
    } satisfies ExecutionWorkCommand;
    expect((await send(4, terminal)).result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect((await send(4, terminal)).result).toMatchObject({ kind: "rejected", reason: "invalid-transition" });
    expect(writer.operations).toHaveLength(3);
  });

  it.each(["claude", "cursor"] as const)("prepares %s parent text, message features, and terminal writes", async (providerId) => {
    const { writer, send, event } = fixture();
    const command = start();
    await send(1, { ...command, providerId, input: { ...command.input, thread: { ...command.input.thread, providerId } } });
    const draft = (sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}) => ({
      ...eventDraft(sequence, type, fields), sourceProviderId: providerId,
    });
    await event(2, draft(1, "turnStarted"));
    await event(3, draft(2, "textDelta", { delta: "Answer", isFinalResponse: true }));
    expect(writer.operations[2]?.mutation).toMatchObject({ parentLive: {
      text: { inputs: [{ sequence: 1, text: "Answer" }] },
    } });
    const message = await event(4, draft(3, "message", { content: "Answer", tokens: null }));
    expect(message.result).toMatchObject({ kind: "committed", parentEvent: {
      runtime: expect.arrayContaining([{ kind: "assistant-message-feature", providerId,
        event: expect.objectContaining({ type: "message", content: "Answer" }) }]),
    } });
    const terminal = draft(4, "error", { error: "Disconnected" });
    const reply = await send(5, { kind: "event", phase: "running", nativeCursor: null, events: [terminal],
      terminalInput: { ...execution, providerId, providerIdentities: [], outcome: "errored", projection: { kind: "writer-staged" } } });
    expect(reply.result.kind).toBe("committed");
    expect(writer.operations[4]?.mutation).toMatchObject({ kind: "finish-live-event", input: { providerId }, providerEvent: { events: [terminal] } });
  });

  it.each(["claude", "cursor"] as const)("rejects unsupported %s events and another provider's drafts", async (providerId) => {
    const { writer, send, event } = fixture();
    const command = start();
    await send(1, { ...command, providerId, input: { ...command.input, thread: { ...command.input.thread, providerId } } });
    expect((await event(2, eventDraft(1, "turnStarted"))).result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect((await event(2, { ...eventDraft(2, "textDelta", { delta: "Before start" }), sourceProviderId: providerId })).result)
      .toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect(writer.operations).toHaveLength(1);
  });

  it("derives text writes inside the worker and commits them with their canonical draft", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    const started = await event(2, eventDraft(1, "turnStarted"));
    expect(started.result).toMatchObject({ kind: "committed", parentEvent: { runtime: [{ kind: "turn-started" }] } });
    const draft = eventDraft(2, "textDelta", { delta: "Answer", isFinalResponse: true });
    const reply = await event(3, draft);
    expect(reply.result.kind).toBe("committed");
    expect(writer.operations[2]).toMatchObject({
      mutation: { kind: "append-events", events: [draft], parentLive: {
        text: { kind: "append", inputs: [{ ...execution, sequence: 1, text: "Answer" }] },
      } }, livePublication: [{ after: "writer", event: { type: "textDelta", delta: "Answer" } }],
    });
  });

  it("rejects caller parent effects when the worker owns the reducer", async () => {
    const { writer, send } = fixture();
    await send(1, start());
    const reply = await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [eventDraft(1, "turnStarted")], parentLive: { text: { kind: "unchanged" } } });
    expect(reply.result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect(writer.operations).toHaveLength(1);
  });

  it("rejects malformed parent identity before writing or advancing the reducer", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    const stale = eventDraft(1, "turnStarted");
    if (stale.payload.type !== "item.recorded") throw new Error("Expected runtime item");
    const reply = await event(2, { ...stale, payload: { ...stale.payload, item: { ...stale.payload.item, turnId: "other" } } });
    expect(reply.result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect(writer.operations).toHaveLength(1);
  });

  it("poisons prepared reducer state when its write conflicts", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    await event(2, eventDraft(1, "turnStarted"));
    writer.fail = true;
    const draft = eventDraft(2, "textDelta", { delta: "Answer" });
    expect((await event(3, draft)).result).toMatchObject({ kind: "rejected", reason: "writer-conflict" });
    writer.fail = false;
    expect((await event(3, draft)).result).toMatchObject({ kind: "rejected", reason: "invalid-transition" });
    expect(writer.operations).toHaveLength(3);
  });

  it("poisons prepared reducer state when the writer throws", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    writer.throwFailure = true;
    await expect(event(2, eventDraft(1, "turnStarted"))).rejects.toThrow("writer disconnected");
    writer.throwFailure = false;
    expect((await event(2, eventDraft(1, "turnStarted"))).result).toMatchObject({ kind: "rejected", reason: "invalid-transition" });
    expect(writer.operations).toHaveLength(2);
  });

  it("requires a matching start message identity and supported provider for live ownership", async () => {
    for (const command of [
      { ...start(), parentLive: { planFeature: "none", precedingMessageId: "other-user" } },
      { ...start(), providerId: "claude" },
    ] satisfies ExecutionWorkCommand[]) {
      const { writer, send } = fixture();
      expect((await send(1, command)).result).toMatchObject({ kind: "rejected", reason: "invalid-transition" });
      expect(writer.operations).toHaveLength(0);
    }
  });

  it("keeps child runtime evidence on the writer path without changing parent text", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    await event(2, eventDraft(1, "turnStarted"));
    const child = eventDraft(2, "textDelta", { delta: "Child answer" });
    if (child.payload.type !== "item.recorded") throw new Error("Expected runtime item");
    const runtime = ProviderRuntimeEventSchema().parse(child.payload.item.payload.runtimeEvent);
    const reply = await event(3, { ...child, payload: { ...child.payload, item: { ...child.payload.item,
      payload: { ...child.payload.item.payload, runtimeEvent: { ...runtime,
        extension: { providerId: "codex", kind: "codex-collaboration",
          child: { nativeThreadId: "child-thread", parentCollaborationItemId: "spawn-1" } } } },
    } } });
    expect(reply.result).toMatchObject({ kind: "committed" });
    expect(reply.result).not.toHaveProperty("parentEvent");
    expect(writer.operations[2]?.mutation).not.toHaveProperty("parentLive");
    await event(4, eventDraft(3, "textDelta", { delta: "Parent answer" }));
    expect(writer.operations[3]?.mutation).toMatchObject({ parentLive: {
      text: { inputs: [{ sequence: 1, text: "Parent answer" }] },
    } });
  });

  it("requires terminal evidence then commits the terminal draft with finish in one operation", async () => {
    const { writer, send, event } = fixture();
    await send(1, start());
    await event(2, eventDraft(1, "turnStarted"));
    await event(3, eventDraft(2, "textDelta", { delta: "Partial answer", isFinalResponse: true }));
    const terminal = eventDraft(3, "error", { error: "Disconnected" });
    expect((await event(4, terminal)).result).toMatchObject({ kind: "rejected", reason: "invalid-event-routing" });
    expect(writer.operations).toHaveLength(3);
    const reply = await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [terminal],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "errored",
        projection: { kind: "writer-staged" } } });
    expect(reply.result).toMatchObject({ kind: "committed", parentEvent: {
      terminal: { outcome: "errored", assistant: { content: "Partial answer" } },
    } });
    expect(writer.operations).toHaveLength(4);
    expect(writer.operations[3]).toMatchObject({ mutation: { kind: "finish-live-event",
      providerEvent: { events: [terminal] }, outcome: "errored",
      projection: { assistant: { content: "Partial answer" } } },
      livePublication: [{ after: "terminal", event: { type: "error", error: "Disconnected" } }],
    });
    expect((await send(5, { kind: "release" })).result).toEqual({ kind: "released" });
  });
});
