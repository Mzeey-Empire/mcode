import { describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import { ParentNarrativeRecoveryCoordinator } from "../parent-narrative-recovery-coordinator.js";
import type { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import type { ParentTurnDurability } from "../parent-turn-durability.js";

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

describe("ParentNarrativeRecoveryCoordinator", () => {
  it("retries an uncommitted parent recovery snapshot before deduplicating it", async () => {
    const recordParentNarrativeRecovery = vi.fn<ParentTurnDurability["recordParentNarrativeRecovery"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const durability = {
      loadTurnByExecution: vi.fn<ParentTurnDurability["loadTurnByExecution"]>(() => ({ id: "turn-1",
        threadId: THREAD_ID, executionId: EXECUTION_ID, status: "Running", trigger: { kind: "user" },
        permissionMode: "supervised", approvalReviewMode: "manual", approvalReviewReason: "fixture",
        providerIdentities: [], startedAt: "2026-08-28T12:00:00.000Z", endedAt: null,
        createdAt: "2026-08-28T12:00:00.000Z", updatedAt: "2026-08-28T12:00:00.000Z" })),
      recordParentNarrativeRecovery,
    } satisfies Pick<ParentTurnDurability, "loadTurnByExecution" | "recordParentNarrativeRecovery">;
    const narrativeStore = {
      terminalSnapshot: vi.fn(() => recoveryItems),
    } satisfies Pick<NarrativeStore, "terminalSnapshot">;
    const coordinator = new ParentNarrativeRecoveryCoordinator(durability, narrativeStore);
    const event: AgentEvent = {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID,
      delta: "Reasoning before the answer.",
    };
    const expectedCommit = {
      executionId: EXECUTION_ID,
      items: recoveryItems,
      discardedItemIds: [],
    };

    await expect(coordinator.checkpoint(event)).rejects.toThrow(
      `Canonical parent turn was not found: ${EXECUTION_ID}`,
    );

    await coordinator.checkpoint(event);
    await coordinator.checkpoint(event);

    expect(recordParentNarrativeRecovery).toHaveBeenCalledTimes(2);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(1, expectedCommit);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(2, expectedCommit);
  });
});
