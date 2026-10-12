import { useCallback, useState } from "react";

/** One end-notice action's request state. */
export interface TurnActionRequest {
  run: (request: () => Promise<unknown>) => void;
  pending: boolean;
  error: string | null;
}

/** Sends end-notice requests for a turn, keeping the server's refusal visible until the next attempt. */
export function useTurnActionRequest(): TurnActionRequest {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((request: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    request()
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setPending(false));
  }, []);
  return { run, pending, error };
}
