import { describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import {
  ParentNarrativeRecoveryCoordinator,
  type ParentNarrativeRecoveryWriter,
} from "../parent-narrative-recovery-coordinator.js";
import type { NarrativeStore } from "../../conversation/narrative/narrative-store.js";

const EXECUTION_ID = "execution-1";
const THREAD_ID = "thread-1";
const recoveryItems = [
  {
    kind: "narrationSegment",
    record: {
      id: "thought-1",
      message_id: "message-1",
      text: "Reasoning before the answer.",
      started_at: "2026-08-28T12:00:00.000Z",
      ended_at: null,
      sort_order: 1,
    },
  },
] satisfies ParentNarrativeRecoveryItem[];
const event: AgentEvent = {
  type: AgentEventType.TextDelta,
  threadId: THREAD_ID,
  turnExecutionId: EXECUTION_ID,
  delta: "Reasoning before the answer.",
};

function coordinatorFor(writer: ParentNarrativeRecoveryWriter): ParentNarrativeRecoveryCoordinator {
  const narrativeStore = {
    recoverySnapshot: vi.fn(() => recoveryItems),
  } as unknown as NarrativeStore;
  return new ParentNarrativeRecoveryCoordinator(writer, narrativeStore);
}

describe("ParentNarrativeRecoveryCoordinator", () => {
  it("retries an uncommitted recovery snapshot with the same operation identity", async () => {
    const recordParentNarrativeRecovery = vi.fn()
      .mockRejectedValueOnce(new Error("writer unavailable"))
      .mockResolvedValue({ recorded: true });
    const writer: ParentNarrativeRecoveryWriter = {
      recordParentNarrativeRecovery,
      classifyParentNarrativeRecovery: vi.fn(),
      acknowledgeOperation: vi.fn(async () => undefined),
    };
    const coordinator = coordinatorFor(writer);
    const expectedCommit = {
      executionId: EXECUTION_ID,
      items: recoveryItems,
      discardedItemIds: [],
    };

    await expect(coordinator.checkpoint(event)).rejects.toThrow("writer unavailable");
    await coordinator.checkpoint(event);
    await coordinator.checkpoint(event);

    expect(recordParentNarrativeRecovery).toHaveBeenCalledTimes(2);
    const operationId = recordParentNarrativeRecovery.mock.calls[0]?.[0];
    expect(operationId).toMatch(/^narrative:/);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(1, operationId, expectedCommit);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(2, operationId, expectedCommit);
    expect(writer.acknowledgeOperation).not.toHaveBeenCalled();
    coordinator.acknowledgeHandled(event);
    await vi.waitFor(() => expect(writer.acknowledgeOperation).toHaveBeenCalledWith(EXECUTION_ID, operationId));
  });

  it("treats a missing execution as a normal receipt and retries its snapshot for later events", async () => {
    const recordParentNarrativeRecovery = vi.fn()
      .mockResolvedValueOnce({ recorded: false })
      .mockResolvedValue({ recorded: true });
    const writer: ParentNarrativeRecoveryWriter = {
      recordParentNarrativeRecovery,
      classifyParentNarrativeRecovery: vi.fn(),
      acknowledgeOperation: vi.fn(async () => undefined),
    };
    const coordinator = coordinatorFor(writer);
    await coordinator.checkpoint(event);
    coordinator.acknowledgeHandled(event);
    const laterEvent = { ...event };
    await coordinator.checkpoint(laterEvent);

    expect(recordParentNarrativeRecovery).toHaveBeenCalledTimes(2);
    expect(recordParentNarrativeRecovery.mock.calls[1]?.[1]).toEqual(recordParentNarrativeRecovery.mock.calls[0]?.[1]);
    expect(recordParentNarrativeRecovery.mock.calls[1]?.[0]).not.toBe(recordParentNarrativeRecovery.mock.calls[0]?.[0]);
  });

  it("retries the atomic narration classification without changing its input", async () => {
    const classifyParentNarrativeRecovery = vi.fn()
      .mockRejectedValueOnce(new Error("writer unavailable"))
      .mockResolvedValue({ recorded: true, reset: true });
    const writer: ParentNarrativeRecoveryWriter = {
      recordParentNarrativeRecovery: vi.fn(),
      classifyParentNarrativeRecovery,
      acknowledgeOperation: vi.fn(async () => undefined),
    };
    const coordinator = coordinatorFor(writer);
    const boundary: AgentEvent = {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID,
      isFinalResponse: false,
    };

    await expect(coordinator.classify(boundary, recoveryItems)).rejects.toThrow("writer unavailable");
    await coordinator.classify(boundary, recoveryItems);
    await coordinator.checkpoint(boundary);

    expect(classifyParentNarrativeRecovery).toHaveBeenCalledTimes(2);
    expect(classifyParentNarrativeRecovery.mock.calls[1]).toEqual(classifyParentNarrativeRecovery.mock.calls[0]);
    expect(writer.acknowledgeOperation).not.toHaveBeenCalled();
    coordinator.acknowledgeHandled(boundary);
    await vi.waitFor(() => expect(writer.acknowledgeOperation).toHaveBeenCalledWith(
      EXECUTION_ID,
      classifyParentNarrativeRecovery.mock.calls[0]?.[0],
    ));
  });
});
