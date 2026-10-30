import { isGoalControlCommand } from "@/lib/goal-command";
import { useThreadStore } from "@/stores/threadStore";
import { useQueueStore } from "@/stores/queueStore";

/** Resolve submit state from the newest snapshot, not an earlier render. */
export function isThreadRunningForSubmit(
  threadId: string | undefined,
  renderedIsAgentRunning: boolean,
): boolean {
  return threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : renderedIsAgentRunning;
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
