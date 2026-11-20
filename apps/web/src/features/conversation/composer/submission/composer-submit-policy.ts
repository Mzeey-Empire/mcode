import { isGoalControlCommand } from "@/lib/goal-command";
import { isThreadExecuting } from "@/stores/threadStore";
import { useQueueStore } from "@/stores/queueStore";

/**
 * Resolve submit state from the newest snapshot, not an earlier render. Uses the
 * same check as the Send/Stop button, so a canonical turn end wins over a stale
 * `runningThreadIds` entry.
 */
export function isThreadRunningForSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
): boolean {
  return threadId ? isThreadExecuting(threadId) : renderedIsAgentRunning;
}

/** Keep existing-thread submits behind the active turn and any earlier queued input. */
export function shouldQueueActiveThreadSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
  branchFromMessageId: string | null | undefined,
  isNewThread: boolean | undefined,
  trimmedContent: string,
): boolean {
  const queue = useQueueStore.getState();
  const hasQueuedInput = threadId && (
    queue.queues[threadId]?.length
    || queue.inFlightQueuedMessages[threadId]
    || queue.editingThreadId === threadId
  );
  return Boolean(
    (isThreadRunningForSubmit(threadId, renderedIsAgentRunning) || hasQueuedInput) &&
      threadId &&
      !branchFromMessageId &&
      !isNewThread &&
      !isGoalControlCommand(trimmedContent),
  );
}
