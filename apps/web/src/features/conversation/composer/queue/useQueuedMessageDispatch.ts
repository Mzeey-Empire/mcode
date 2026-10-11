import { useCallback } from "react";
import type { QueuedMessage } from "@/stores/queueStore";
import { useQueueStore } from "@/stores/queueStore";
import { getThreadRecord } from "@/stores/thread-record";
import { isThreadExecuting, sendQueuedMessage, useThreadStore } from "@/stores/threadStore";
import { steerQueuedMessage } from "./queued-steer";

/** Sends a queued message now: at once when idle, by steering into the turn while one runs. */
export function useQueuedMessageDispatch(threadId: string | undefined): {
  sendNow(message: QueuedMessage): Promise<void>;
} {
  const sendNow = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      // A turn being stopped takes neither a steer nor a new send.
      if (useThreadStore.getState().pendingStopCounts[threadId]) return;
      if (isThreadExecuting(threadId)) {
        const { turnExecutionId } = getThreadRecord(useThreadStore.getState().records, threadId);
        if (turnExecutionId) await steerQueuedMessage(threadId, message.id, turnExecutionId);
        return;
      }
      const queueState = useQueueStore.getState();
      const queued = queueState.claimQueuedMessage(threadId, message.id);
      if (!queued) return;
      // Sending by hand after a Stop restarts the queue, so the rest follows this turn.
      queueState.resumeAutoDrain(threadId);
      await sendQueuedMessage(threadId, queued);
    },
    [threadId],
  );

  return { sendNow };
}
