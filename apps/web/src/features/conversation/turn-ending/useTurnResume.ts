import { useCallback } from "react";
import { getTransport } from "@/transport";
import { useTurnActionRequest } from "./useTurnActionRequest";

/** Resume state for one interrupted turn. */
export interface TurnResume {
  /** Resume now, optionally on another model of the same provider. */
  resume: (model?: string) => void;
  pending: boolean;
  error: string | null;
}

/** Resumes a thread's latest interrupted turn, keeping the server's refusal visible. */
export function useTurnResume(threadId: string, turnId: string): TurnResume {
  const { run, pending, error } = useTurnActionRequest();
  const resume = useCallback(
    (model?: string) => run(() => getTransport().resumeInterruptedTurn({ threadId, turnId, ...(model ? { model } : {}) })),
    [run, threadId, turnId],
  );
  return { resume, pending, error };
}
