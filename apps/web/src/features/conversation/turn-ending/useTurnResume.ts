import { useCallback } from "react";
import { getTransport } from "@/transport";
import { useTurnActionRequest } from "./useTurnActionRequest";

/** Resume state for one interrupted turn's end notice. */
export interface TurnResume {
  resume: () => void;
  pending: boolean;
  error: string | null;
}

/** Resumes a thread's latest interrupted turn, keeping the server's refusal visible. */
export function useTurnResume(threadId: string, turnId: string): TurnResume {
  const { run, pending, error } = useTurnActionRequest();
  const resume = useCallback(
    () => run(() => getTransport().resumeInterruptedTurn({ threadId, turnId })),
    [run, threadId, turnId],
  );
  return { resume, pending, error };
}
