import { describe, expect, it, vi } from "vitest";
import { AgentEventType, providerRuntimeEvent, type AgentEvent } from "@mcode/contracts";
import type { ProviderEventSinkPort, ProviderEventSubmissionReceipt } from "@mcode/providers";
import {
  ClaudeCanonicalEventPublisher,
  type ClaudeCanonicalEventRouting,
} from "../claude-canonical-event-publisher.js";

const routing: ClaudeCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "00000000-0000-4000-8000-000000000001",
  deliveryAttempt: 1,
};

/** Builds the narrow host port needed to inspect Claude canonical submissions. */
function createSink(submit: ProviderEventSinkPort["submit"]): ProviderEventSinkPort {
  return { submit };
}
const receipt: ProviderEventSubmissionReceipt = { commit: { outcome: "committed", acceptedThrough: 1, durableThrough: 1, conversationRevision: 1, rosterRevision: 0, eventCount: 1 }, delivery: { ingress: "queued" } };

describe("ClaudeCanonicalEventPublisher", () => {
  it("submits a provider runtime event without a renderer publication claim", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit));
    const terminal = {
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "claude",
    } satisfies AgentEvent;

    publisher.publish(routing, providerRuntimeEvent(terminal), [{
      providerId: "claude",
      scope: "session",
      value: "native-session-1",
      provenance: "native",
    }]);
    await publisher.waitForExecution(routing);

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      batchId: `claude:${routing.executionId}:attempt:1:event:1`,
      deliveryAttempt: 1,
      events: [expect.objectContaining({
        eventId: `claude:${routing.executionId}:attempt:1:event:1`,
        sourceProviderId: "claude",
        sourceSequence: 1,
        payload: expect.objectContaining({
          type: "item.recorded",
          item: expect.objectContaining({
            payload: {
              projection: "providerRuntimeEvent",
              runtimeEvent: { event: terminal },
              provenance: "generated",
            },
          }),
        }),
      })],
    }));
  });

  it("keeps attempt-scoped ordering stable for duplicate and conflicting terminal evidence", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit));
    const completed = {
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "claude",
    } satisfies AgentEvent;
    const errored = {
      type: AgentEventType.Error,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      error: "late SDK failure",
    } satisfies AgentEvent;

    publisher.publish(routing, providerRuntimeEvent(completed), []);
    publisher.publish(routing, providerRuntimeEvent(completed), []);
    publisher.publish(routing, providerRuntimeEvent(errored), []);
    await publisher.waitForExecution(routing);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([
      `claude:${routing.executionId}:attempt:1:event:1`,
      `claude:${routing.executionId}:attempt:1:event:2`,
      `claude:${routing.executionId}:attempt:1:event:3`,
    ]);
  });

  it("checks a completed turn without resetting sequence for late SDK events", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit));
    const event = providerRuntimeEvent({
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "late-hook",
      turnExecutionId: routing.executionId,
    });

    publisher.publish(routing, event, []);
    await publisher.flushForExecution(routing);
    publisher.publish(routing, event, []);
    await publisher.waitForExecution(routing);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.sourceSequence)).toEqual([1, 2]);
  });

  it("deduplicates known native replay and rejects a conflicting semantic event", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const failure = vi.fn();
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit), failure);
    const event = providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "fixture" });
    publisher.publish(routing, event, [], "NATIVE_EVENT_1");
    await publisher.flushForExecution(routing);
    publisher.publish(routing, event, [], "NATIVE_EVENT_1");
    await publisher.flushForExecution(routing);
    expect(submit).toHaveBeenCalledOnce();
    publisher.publish(routing, { ...event, parentEvidence: { kind: "root" } }, [], "NATIVE_EVENT_1");
    await expect(publisher.waitForExecution(routing)).rejects.toThrow("Conflicting provider replay identity");
    expect(failure).toHaveBeenCalledExactlyOnceWith(routing, expect.any(Error));
  });

  it.each([1_023, 1_024, 1_025])("fails queue overflow explicitly at %i pending events", async (count) => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockResolvedValue(receipt);
    const failure = vi.fn();
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit), failure);
    for (let i = 0; i < count; i++) publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "fixture" }), []);
    if (count > 1_024) {
      expect(failure).toHaveBeenCalledOnce();
      await expect(publisher.waitForExecution(routing)).rejects.toThrow("overflowed");
    } else {
      await publisher.waitForExecution(routing);
      expect(submit).toHaveBeenCalledTimes(count);
      expect(failure).not.toHaveBeenCalled();
    }
  });

  it("retains a delivered execution failure after retirement for provider shutdown", async () => {
    const submit = vi.fn<ProviderEventSinkPort["submit"]>().mockRejectedValue(new Error("Sink unavailable"));
    const failure = vi.fn();
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit), failure);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.System, threadId: routing.threadId, subtype: "fixture" }), []);
    await expect(publisher.waitForExecution(routing)).rejects.toThrow("Sink unavailable");
    await expect(publisher.stopAdmissionAndDrain()).rejects.toThrow("Provider canonical event shutdown failed");
    expect(failure).toHaveBeenCalledExactlyOnceWith(routing, expect.any(Error));
  });
});
