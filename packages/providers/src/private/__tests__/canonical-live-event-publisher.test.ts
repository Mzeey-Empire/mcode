import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts/events/agent-event";
import { providerRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import type { ProviderEventBatch, ProviderEventSinkPort } from "../../host-ports.js";
import { CanonicalLiveEventPublisher, type CanonicalLiveEventRouting } from "../canonical-live-event-publisher.js";

const routing: CanonicalLiveEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "00000000-0000-4000-8000-000000000001",
  deliveryAttempt: 1,
};

function recordingPublisher() {
  const submitted: AgentEvent["type"][] = [];
  const sink: ProviderEventSinkPort = { submit: async (batch: ProviderEventBatch) => {
    for (const draft of batch.events) {
      if (draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent") {
        submitted.push(draft.payload.item.payload.runtimeEvent.event.type);
      }
    }
    return { commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1,
      progressPosition: { epoch: routing.executionId, sequence: 1 } }, delivery: { ingress: "not-required" } };
  } };
  const onFailure = vi.fn();
  return { publisher: new CanonicalLiveEventPublisher("unbounded", "claude", sink, onFailure), submitted, onFailure };
}

const ended = (fields: Partial<Extract<AgentEvent, { type: "ended" }>> = {}) => providerRuntimeEvent({
  type: AgentEventType.Ended, threadId: routing.threadId, turnExecutionId: routing.executionId, ...fields });
const lateToolUse = providerRuntimeEvent({ type: AgentEventType.ToolUse, threadId: routing.threadId,
  toolCallId: "AGENT_1", toolName: "Agent", toolInput: {} });

describe("CanonicalLiveEventPublisher after an execution ends", () => {
  // The server worker rejects any event for an ended execution without consuming its mailbox slot,
  // so the turn's release then fails out of order and recovery stops the session.
  it("never submits an event published for an execution after its Ended, whether or not the execution was drained", async () => {
    const { publisher, submitted, onFailure } = recordingPublisher();
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TurnComplete, threadId: routing.threadId }), []);
    publisher.publish(routing, ended(), []);
    publisher.publish(routing, lateToolUse, []);
    await publisher.waitForExecution(routing);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.CompactSummary, threadId: routing.threadId, summary: "s" }), []);
    await publisher.waitForExecution(routing);

    expect(submitted).toEqual([AgentEventType.TurnComplete, AgentEventType.Ended]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  // A background subagent can run for hours while every other thread keeps ending turns.
  it("still drops a late event after many other threads end their turns", async () => {
    const { publisher, submitted, onFailure } = recordingPublisher();
    publisher.publish(routing, ended(), []);
    await publisher.waitForExecution(routing);
    for (let index = 0; index < 300; index += 1) {
      const other = { ...routing, threadId: `thread-other-${index}`, executionId: `execution-other-${index}` };
      publisher.publish(other, providerRuntimeEvent({ type: AgentEventType.Ended, threadId: other.threadId,
        turnExecutionId: other.executionId }), []);
      await publisher.waitForExecution(other);
    }
    submitted.length = 0;
    publisher.publish(routing, lateToolUse, []);
    await publisher.waitForExecution(routing);

    expect(submitted).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  // A pending approval keeps the routing it was requested under while the thread runs later turns.
  it("still drops a late event after many later turns of the same thread end", async () => {
    const { publisher, submitted, onFailure } = recordingPublisher();
    publisher.publish(routing, ended(), []);
    await publisher.waitForExecution(routing);
    for (let index = 0; index < 20; index += 1) {
      const later = { ...routing, turnId: `turn-later-${index}`, executionId: `execution-later-${index}` };
      publisher.publish(later, providerRuntimeEvent({ type: AgentEventType.Ended, threadId: later.threadId,
        turnExecutionId: later.executionId }), []);
      await publisher.waitForExecution(later);
    }
    submitted.length = 0;
    publisher.publish(routing, lateToolUse, []);
    await publisher.waitForExecution(routing);

    expect(submitted).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("still submits post-terminal hooks and the Ended that follow a turn completion", async () => {
    const { publisher, submitted } = recordingPublisher();
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.TurnComplete, threadId: routing.threadId }), []);
    publisher.publish(routing, providerRuntimeEvent({ type: AgentEventType.HookStarted, threadId: routing.threadId,
      hookName: "Stop", hookType: "stop" }), []);
    publisher.publish(routing, ended(), []);
    await publisher.waitForExecution(routing);

    expect(submitted).toEqual([AgentEventType.TurnComplete, AgentEventType.HookStarted, AgentEventType.Ended]);
  });

  // The server keeps a lost provider stream open for the turn's real ending.
  it("keeps admitting events after an Ended that only reports a lost provider stream", async () => {
    const { publisher, submitted } = recordingPublisher();
    publisher.publish(routing, ended({ reason: "provider_lost" }), []);
    publisher.publish(routing, ended({ outcome: "interrupted" }), []);
    await publisher.waitForExecution(routing);

    expect(submitted).toEqual([AgentEventType.Ended, AgentEventType.Ended]);
  });

  it("keeps a retry attempt of the same execution open after the earlier attempt ended", async () => {
    const { publisher, submitted } = recordingPublisher();
    publisher.publish(routing, ended(), []);
    await publisher.waitForExecution(routing);
    publisher.publish({ ...routing, deliveryAttempt: 2 }, lateToolUse, []);
    await publisher.waitForExecution({ ...routing, deliveryAttempt: 2 });

    expect(submitted).toEqual([AgentEventType.Ended, AgentEventType.ToolUse]);
  });
});
