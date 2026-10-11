import { useCallback, useState } from "react";

/** One end-notice action's request state. */
export interface TurnActionRequest {
  run: () => void;
  pending: boolean;
  error: string | null;
}

/** Sends one end-notice action for a turn, keeping the server's refusal visible until the next attempt. */
export function useTurnActionRequest(
  threadId: string,
  turnId: string,
  send: (params: { threadId: string; turnId: string }) => Promise<unknown>,
): TurnActionRequest {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => {
    setPending(true);
    setError(null);
    send({ threadId, turnId })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setPending(false));
  }, [send, threadId, turnId]);
  return { run, pending, error };
}
