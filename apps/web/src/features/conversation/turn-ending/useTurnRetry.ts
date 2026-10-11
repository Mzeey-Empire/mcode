import { useCallback, useState } from "react";
import { getTransport } from "@/transport";

/** Retry state for one errored turn's end notice. */
export interface TurnRetry {
  retry: () => void;
  pending: boolean;
  error: string | null;
}

/** Retries a thread's latest errored turn in the same provider session, keeping the server's refusal visible. */
export function useTurnRetry(threadId: string, turnId: string): TurnRetry {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(() => {
    setPending(true);
    setError(null);
    getTransport()
      .retryErroredTurn({ threadId, turnId })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setPending(false));
  }, [threadId, turnId]);
  return { retry, pending, error };
}
