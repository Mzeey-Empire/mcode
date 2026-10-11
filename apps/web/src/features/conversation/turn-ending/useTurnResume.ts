import { getTransport } from "@/transport";
import { useTurnActionRequest } from "./useTurnActionRequest";

/** Resume state for one interrupted turn's end notice. */
export interface TurnResume {
  resume: () => void;
  pending: boolean;
  error: string | null;
}

const resumeInterruptedTurn = (params: { threadId: string; turnId: string }) => getTransport().resumeInterruptedTurn(params);

/** Resumes a thread's latest interrupted turn, keeping the server's refusal visible. */
export function useTurnResume(threadId: string, turnId: string): TurnResume {
  const { run, pending, error } = useTurnActionRequest(threadId, turnId, resumeInterruptedTurn);
  return { resume: run, pending, error };
}
