import { useCallback } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { useTurnActionRequest } from "./useTurnActionRequest";

/** Retry state for one errored turn's end notice. */
export interface TurnRetry {
  /** Retry now, optionally on another model of the same provider. */
  retry: (model?: string) => void;
  /** Schedule a retry at `at`; a time already past retries now instead. */
  retryAt: (at: string) => void;
  /** Cancel the thread's scheduled retry. */
  cancelRetry: () => void;
  pending: boolean;
  error: string | null;
}

/** Retries a thread's latest errored turn in the same provider session, keeping the server's refusal visible. */
export function useTurnRetry(threadId: string, turnId: string): TurnRetry {
  const { run, pending, error } = useTurnActionRequest();
  const retry = useCallback(
    (model?: string) => run(() => getTransport().retryErroredTurn({ threadId, turnId, ...(model ? { model } : {}) })),
    [run, threadId, turnId],
  );
  const retryAt = useCallback((at: string) => {
    // The notice can outlive its reset time; the server refuses a schedule in the past.
    if (Date.parse(at) <= Date.now()) return retry();
    run(async () => {
      const scheduled = await getTransport().scheduleTurnRetry({ threadId, turnId, at });
      useWorkspaceStore.getState().applyScheduledRetry(threadId, scheduled);
    });
  }, [retry, run, threadId, turnId]);
  const cancelRetry = useCallback(() => run(async () => {
    await getTransport().unscheduleTurnRetry(threadId);
    useWorkspaceStore.getState().applyScheduledRetry(threadId, null);
  }), [run, threadId]);
  return { retry, retryAt, cancelRetry, pending, error };
}
