import { getTransport } from "@/transport";
import { useTurnActionRequest } from "./useTurnActionRequest";

/** Retry state for one errored turn's end notice. */
export interface TurnRetry {
  retry: () => void;
  pending: boolean;
  error: string | null;
}

const retryErroredTurn = (params: { threadId: string; turnId: string }) => getTransport().retryErroredTurn(params);

/** Retries a thread's latest errored turn in the same provider session, keeping the server's refusal visible. */
export function useTurnRetry(threadId: string, turnId: string): TurnRetry {
  const { run, pending, error } = useTurnActionRequest(threadId, turnId, retryErroredTurn);
  return { retry: run, pending, error };
}
