import { useCallback } from "react";
import type { QueuedMessage } from "@/stores/queueStore";
import { useQueueStore } from "@/stores/queueStore";
import { getThreadRuntimePhase } from "@/stores/thread-lifecycle";
import { getThreadRecord } from "@/stores/thread-record";
import { isThreadExecuting, sendQueuedMessage, useThreadStore } from "@/stores/threadStore";
import { requestTranscriptFollow } from "@/features/conversation/messages/transcript-follow-request";
import { steerQueuedMessage } from "./queued-steer";

/** What Send now does for a thread at this moment: send at once, steer the running turn, or nothing. */
export type SendNowRoute =
  | { readonly kind: "send" }
  | { readonly kind: "steer"; readonly turnExecutionId: string }
  | { readonly kind: "none" };

type ThreadState = ReturnType<typeof useThreadStore.getState>;

const NO_ROUTE: SendNowRoute = { kind: "none" };
const SEND_ROUTE: SendNowRoute = { kind: "send" };

function sendNowRoute(threadId: string, threadState: ThreadState, leased: boolean): SendNowRoute {
  // A turn being stopped takes neither a steer nor a new send.
  if (threadState.pendingStopCounts[threadId]) return NO_ROUTE;
  if (!isThreadExecuting(threadId, threadState)) return leased ? NO_ROUTE : SEND_ROUTE;
  const record = getThreadRecord(threadState.records, threadId);
  // The server takes a steer only while the turn runs, and a finalizing turn cannot start another.
  if (getThreadRuntimePhase(threadId, record) === "finalizing") return NO_ROUTE;
  // Until the server admits the new turn, the record still names the previous one.
  if (record.optimisticUserMessageId || !record.turnExecutionId) return NO_ROUTE;
  return { kind: "steer", turnExecutionId: record.turnExecutionId };
}

/** The current Send now route, so a row offers the action only when it would do something. */
export function useSendNowRoute(threadId: string): SendNowRoute["kind"] {
  const leased = useQueueStore((state) => Boolean(state.inFlightQueuedMessages[threadId]));
  return useThreadStore((state) => sendNowRoute(threadId, state, leased).kind);
}

/** Sends a queued message now: at once when idle, by steering into the turn while one runs. */
export function useQueuedMessageDispatch(threadId: string | undefined): {
  sendNow(message: QueuedMessage): Promise<void>;
} {
  const sendNow = useCallback(
    async (message: QueuedMessage): Promise<void> => {
      if (!threadId) return;
      const leased = Boolean(useQueueStore.getState().inFlightQueuedMessages[threadId]);
      const route = sendNowRoute(threadId, useThreadStore.getState(), leased);
      if (route.kind === "none") return;
      // Send now is an explicit Send, unlike the automatic drain, so it brings the reader to the prompt.
      requestTranscriptFollow(threadId);
      if (route.kind === "steer") {
        // Steering is an explicit send too, so the rest of the queue follows once this turn completes.
        useQueueStore.getState().resumeAutoDrain(threadId);
        await steerQueuedMessage(threadId, message.id, route.turnExecutionId);
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
