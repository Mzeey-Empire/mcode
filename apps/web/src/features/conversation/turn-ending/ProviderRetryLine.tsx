import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { providerRetryDetail, secondsUntilNextAttempt, type ProviderRetry } from "./provider-retry";

/** Re-renders once a second until the countdown reaches zero, then stops ticking. */
function useCountdownNow(retry: ProviderRetry): number {
  const [tickedAt, setNow] = useState(() => Date.now());
  // A notice that lands between ticks is newer than the last tick, so it would read longer than its delay.
  const now = Math.max(tickedAt, retry.receivedAt);
  const counting = secondsUntilNextAttempt(retry, now) > 0;

  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting, retry]);

  return now;
}

/** Props for {@link ProviderRetryLine}. */
interface ProviderRetryLineProps {
  retry: ProviderRetry;
  /** Display name of the thread's provider, for example "Codex". */
  providerLabel: string;
}

/**
 * Quiet line under the running turn's work while the provider retries on its own (08f, decision R7):
 * "Codex is retrying" over "502 Bad Gateway · attempt 2 of 10 · next in 8s". It has no action
 * because the provider owns the retry.
 */
export function ProviderRetryLine({ retry, providerLabel }: ProviderRetryLineProps) {
  const now = useCountdownNow(retry);
  const detail = providerRetryDetail(retry, now);

  return (
    <div role="status" className="flex items-center gap-3 py-1 pr-2.5" data-testid="provider-retry-line">
      <Spinner size={16} className="text-muted" />
      <div className="flex min-w-0 grow flex-col gap-0.5 text-muted">
        <span className="text-body-small">{providerLabel} is retrying</span>
        {detail && <span className="text-caption">{detail}</span>}
      </div>
    </div>
  );
}
