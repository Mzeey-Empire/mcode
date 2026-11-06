import { describe, expect, it, vi } from "vitest";
import { AgentEventRoutingSchema } from "@mcode/agent-model";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { providerRuntimeEvent, ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import type { ProviderEventBatch, ProviderEventSinkPort, ProviderEventSubmissionReceipt } from "../../host-ports.js";
import {
  CodexCanonicalEventPublisher,
  type CodexCanonicalEventRouting,
} from "../../private/codex/codex-canonical-event-publisher.js";

const routing: CodexCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "00000000-0000-4000-8000-000000000001",
  deliveryAttempt: 1,
};

const acceptedReceipt: ProviderEventSubmissionReceipt = {
  commit: {
    outcome: "committed",
    conversationRevision: 1,
    rosterRevision: 1,
    acceptedThrough: 1,
    durableThrough: 1,
    eventCount: 1,
  },
  delivery: { ingress: "queued" },
};

function sink(submit: ProviderEventSinkPort["submit"]): ProviderEventSinkPort {
  return { submit };
}

describe("CodexCanonicalEventPublisher", () => {
  it("labels parent text, reasoning and tool input live, leaving boundaries and child text saved", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>().mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const base = { threadId: routing.threadId, turnExecutionId: routing.executionId };
    const childText = ProviderRuntimeEventSchema().parse(providerRuntimeEvent(
      { ...base, type: AgentEventType.TextDelta, delta: "child", isFinalResponse: false },
      { providerId: "codex", kind: "codex-collaboration", child: {
        nativeThreadId: "child-thread", parentCollaborationItemId: "spawn-1", nativeItemId: "child-item", itemEventKey: "stream" } },
    ));
    const published = [
      providerRuntimeEvent({ ...base, type: AgentEventType.TextDelta, delta: "Hello", isFinalResponse: false }),
      providerRuntimeEvent({ ...base, type: AgentEventType.ReasoningDelta, delta: "thinking", reasoningItemId: "reason-1" }),
      providerRuntimeEvent({ ...base, type: AgentEventType.ToolInputDelta, partialJson: "{\"cmd\":" }),
      providerRuntimeEvent({ ...base, type: AgentEventType.Message, content: "Hello", tokens: null }),
      providerRuntimeEvent({ ...base, type: AgentEventType.ToolUse, toolCallId: "tool-1", toolName: "shell", toolInput: {} }),
      childText,
    ];
    for (const runtimeEvent of published) publisher.publish(routing, { ...runtimeEvent, deliveryAttempt: 1 });

    await publisher.waitForExecution(routing);
    const deliveries = submit.mock.calls.flatMap(([batch]) => batch.events.map((draft) => draft.delivery));
    expect(deliveries).toEqual(["live", "live", "live", undefined, undefined, undefined]);
  });

  it("submits exact ordered drafts with stable batch, item and event IDs", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>().mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));

    publisher.publish(routing, {
      ...providerRuntimeEvent({
        type: AgentEventType.TextDelta,
        threadId: routing.threadId,
        turnExecutionId: routing.executionId,
        delta: "Hello",
      }),
      deliveryAttempt: 1,
    });
    publisher.publish(routing, {
      ...providerRuntimeEvent({
        type: AgentEventType.Ended,
        threadId: routing.threadId,
        turnExecutionId: routing.executionId,
      }),
      deliveryAttempt: 1,
    });

    await publisher.waitForExecution(routing);
    expect(submit).toHaveBeenCalledTimes(2);
    const [textBatch, endedBatch] = submit.mock.calls.map(([batch]) => batch);
    expect(textBatch).toMatchObject({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      deliveryAttempt: 1,
      phase: "running",
      batchId: `codex:${routing.executionId}:attempt:1:event:1`,
      events: [{
        eventId: `codex:${routing.executionId}:attempt:1:event:1`,
        sourceProviderId: "codex",
        sourceSequence: 1,
        ingestClass: "volatile",
      }],
    });
    expect(textBatch.events[0]?.routing.itemId).toBe(`codex:${routing.executionId}:attempt:1:item:1`);
    AgentEventRoutingSchema.parse(textBatch.events[0]?.routing);
    expect(endedBatch.events[0]?.sourceSequence).toBe(2);
    expect(endedBatch.events[0]?.payload).toMatchObject({
      type: "item.recorded",
      item: { payload: { projection: "providerRuntimeEvent", runtimeEvent: {
        deliveryAttempt: 1,
        event: { type: AgentEventType.Ended, turnExecutionId: routing.executionId },
      } } },
    });
  });

  it("marks reasoning deltas volatile like text deltas and keeps structural events durable", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>().mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));

    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.ReasoningDelta,
      threadId: routing.threadId,
      delta: "Weighing options",
      reasoningItemId: "rs_1",
    }));
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" }));
    await publisher.waitForExecution(routing);

    const [reasoningEvent, systemEvent] = submit.mock.calls.flatMap(([batch]) => batch.events);
    expect(reasoningEvent?.ingestClass).toBe("volatile");
    expect(systemEvent).not.toHaveProperty("ingestClass");
  });

  it("uses a distinct sequence for a retry of the same execution", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>().mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    await publisher.waitForExecution(routing);
    const retry = { ...routing, deliveryAttempt: 2 };
    publisher.publish(retry, { ...event, deliveryAttempt: 2 });
    await publisher.waitForExecution(retry);

    expect(submit.mock.calls.map(([batch]) => batch.batchId)).toEqual([
      `codex:${routing.executionId}:attempt:1:event:1`,
      `codex:${routing.executionId}:attempt:2:event:1`,
    ]);
  });

  it("continues the sequence for an event after the first delivery drain", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>().mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    await publisher.waitForExecution(routing);
    publisher.publish(routing, event);
    await publisher.retireExecution(routing);

    expect(submit.mock.calls.map(([batch]) => batch.batchId)).toEqual([
      `codex:${routing.executionId}:attempt:1:event:1`,
      `codex:${routing.executionId}:attempt:1:event:2`,
    ]);
  });

  it("discards queued events at Stop while awaiting the current sink call", async () => {
    let completeFirst!: (receipt: ProviderEventSubmissionReceipt) => void;
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockImplementation(() => new Promise((resolve) => { completeFirst = resolve; }));
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const onFailure = vi.fn();
    publisher.setFailureHandler(onFailure);
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    for (let index = 0; index < 40; index++) publisher.publish(routing, event);
    const drained = publisher.discardQueuedForExecution(routing);
    publisher.publish(routing, event);
    completeFirst(acceptedReceipt);
    await drained;

    expect(submit).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    await publisher.retireExecution(routing);
  });

  it("continues through a failed observation to native completion", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockRejectedValueOnce(new Error("canonical sink unavailable")).mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    publisher.publish(routing, event);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.Ended, threadId: routing.threadId,
      turnExecutionId: routing.executionId, outcome: "completed" }));

    await publisher.waitForExecution(routing);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("reports the first sink failure for the exact attempt before a delivery drain", async () => {
    let rejectSubmit!: (error: Error) => void;
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockImplementation(() => new Promise((_, reject) => { rejectSubmit = reject; }));
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const onFailure = vi.fn(async () => undefined);
    publisher.setFailureHandler(onFailure);
    const event = providerRuntimeEvent({ type: AgentEventType.Ended, threadId: routing.threadId, outcome: "completed" });

    publisher.publish(routing, event);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    rejectSubmit(new Error("writer unavailable"));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      routing,
      expect.objectContaining({ message: "writer unavailable" }),
    ));

    publisher.publish(routing, event);
    await expect(publisher.waitForExecution(routing)).rejects.toThrow("writer unavailable");
    expect(submit).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it.each(["conflict", "ingest-overflow"] as const)("continues past an observation with a %s receipt", async (outcome) => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockResolvedValue({ ...acceptedReceipt, commit: { ...acceptedReceipt.commit, outcome } });
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    publisher.publish(routing, event);

    await publisher.waitForExecution(routing);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("pauses the stream instead of dropping events while saving falls behind, then saves every event in order", async () => {
    // Every save takes a macrotask, so the whole burst is admitted before the first save finishes.
    const submit = vi.fn<ProviderEventSinkPort["submit"]>()
      .mockImplementation(() => new Promise((resolve) => { setImmediate(() => resolve(acceptedReceipt)); }));
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const onFailure = vi.fn();
    publisher.setFailureHandler(onFailure);
    const pressure: boolean[] = [];
    publisher.setBackpressureHandler((threadId, paused) => {
      expect(threadId).toBe(routing.threadId);
      pressure.push(paused);
    });

    const deltas = 3_000;
    for (let index = 0; index < deltas; index++) {
      publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TextDelta, threadId: routing.threadId,
        turnExecutionId: routing.executionId, delta: `${index}` }));
    }
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.Ended, threadId: routing.threadId,
      turnExecutionId: routing.executionId, outcome: "completed" }));
    expect(pressure).toEqual([true]);

    await publisher.waitForExecution(routing);

    expect(pressure).toEqual([true, false]);
    const delivered = submit.mock.calls.map(([batch]) => batch.events[0]!);
    expect(delivered.map((event) => event.sourceSequence)).toEqual(Array.from({ length: deltas + 1 }, (_, index) => index + 1));
    expect(delivered.at(-1)?.payload).toMatchObject({ type: "item.recorded",
      item: { payload: { runtimeEvent: { event: { type: "ended", outcome: "completed" } } } } });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("resumes a paused stream promptly when Stop discards the queued events", async () => {
    let completeFirst!: (receipt: ProviderEventSubmissionReceipt) => void;
    const submit = vi.fn<ProviderEventSinkPort["submit"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { completeFirst = resolve; }))
      .mockResolvedValue(acceptedReceipt);
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const pressure: boolean[] = [];
    publisher.setBackpressureHandler((_threadId, paused) => { pressure.push(paused); });
    const notice = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    for (let index = 0; index < 1_000; index++) publisher.publish(routing, notice);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(pressure).toEqual([true]);
    const discarded = publisher.discardQueuedForExecution(routing);
    completeFirst(acceptedReceipt);
    await discarded;

    // Stop must not wait for the backlog to save: the interrupt response is read from the paused stream.
    expect(pressure).toEqual([true, false]);
    expect(submit).toHaveBeenCalledOnce();
  });
});
