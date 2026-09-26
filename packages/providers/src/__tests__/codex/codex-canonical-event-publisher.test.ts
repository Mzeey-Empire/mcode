import { describe, expect, it, vi } from "vitest";
import { AgentEventRoutingSchema } from "@mcode/agent-model";
import { AgentEventType, providerRuntimeEvent } from "@mcode/contracts";
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

  it("stops submitting later events after the sink fails", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockRejectedValueOnce(new Error("canonical sink unavailable"));
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    publisher.publish(routing, event);

    await expect(publisher.waitForExecution(routing)).rejects.toThrow("canonical sink unavailable");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reports the first sink failure for the exact attempt before a delivery drain", async () => {
    let rejectSubmit!: (error: Error) => void;
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockImplementation(() => new Promise((_, reject) => { rejectSubmit = reject; }));
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const onFailure = vi.fn(async () => undefined);
    publisher.setFailureHandler(onFailure);
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

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

  it.each(["conflict", "ingest-overflow"] as const)("rejects a resolved %s receipt", async (outcome) => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<ProviderEventSubmissionReceipt>>()
      .mockResolvedValue({ ...acceptedReceipt, commit: { ...acceptedReceipt.commit, outcome } });
    const publisher = new CodexCanonicalEventPublisher(sink(submit));
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "notice" });

    publisher.publish(routing, event);
    publisher.publish(routing, event);

    await expect(publisher.waitForExecution(routing)).rejects.toThrow(outcome);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
