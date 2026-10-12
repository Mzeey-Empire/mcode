import { useCallback } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { useTurnActionRequest } from "../turn-ending/useTurnActionRequest";

/** What the usage-limit row can do with the stopped turn. */
export interface UsageLimitActions {
  /** Resume now, optionally on another model of the same provider. */
  resume: (model?: string) => void;
  /** Schedule a resume at `at`; a time already past resumes now instead. */
  resumeAt: (at: string) => void;
  /** Cancel the thread's scheduled resume. */
  cancel: () => void;
  pending: boolean;
  error: string | null;
}

/** Resumes, schedules, or unschedules a usage-limited turn, keeping the server's refusal visible. */
export function useUsageLimitActions(threadId: string, turnId: string): UsageLimitActions {
  // One request state, so a refusal clears on whichever action the user tries next.
  const { run, pending, error } = useTurnActionRequest();
  const resume = useCallback(
    (model?: string) => run(() => getTransport().resumeInterruptedTurn({ threadId, turnId, ...(model ? { model } : {}) })),
    [run, threadId, turnId],
  );
  const resumeAt = useCallback((at: string) => {
    // The row can outlive the reset time; the server refuses a schedule in the past.
    if (Date.parse(at) <= Date.now()) return resume();
    run(async () => {
      const scheduled = await getTransport().scheduleTurnResume({ threadId, turnId, at });
      useWorkspaceStore.getState().applyScheduledResume(threadId, scheduled);
    });
  }, [resume, run, threadId, turnId]);
  const cancel = useCallback(() => run(async () => {
    await getTransport().unscheduleTurnResume(threadId);
    useWorkspaceStore.getState().applyScheduledResume(threadId, null);
  }), [run, threadId]);
  return { resume, resumeAt, cancel, pending, error };
}
