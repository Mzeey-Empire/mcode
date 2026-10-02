import type { TurnSavingStatus } from "@mcode/contracts";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getTransport } from "@/transport";

/** Discloses confirmed progress loss after a server restart, separately from save status. */
export function TurnSavingNotice({ lostProgress }: { lostProgress: boolean }) {
  if (!lostProgress) return null;
  return <div className="mx-3 mb-2 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground" data-testid="turn-saving-notice">
    <p role="alert">Mcode restarted. Progress that had not been saved was lost.</p>
  </div>;
}

/** Offers save-only recovery in thread Overview without announcing storage failures in chat. */
export function TurnSaveRecovery({ statuses }: { statuses: readonly TurnSavingStatus[] }) {
  const inFlight = useRef(new Set<string>());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const retrySave = async (threadId: string): Promise<void> => {
    if (inFlight.current.has(threadId)) return;
    inFlight.current.add(threadId);
    setRetrying(new Set(inFlight.current));
    setErrors((previous) => { const next = { ...previous }; delete next[threadId]; return next; });
    try {
      await getTransport().retrySave(threadId);
    } catch {
      setErrors((previous) => ({ ...previous, [threadId]: "Save could not be retried. Try again." }));
    } finally {
      inFlight.current.delete(threadId);
      setRetrying(new Set(inFlight.current));
    }
  };
  const threadIds = [...new Set(statuses.filter((status) => status.mode === "saving-failed").map((status) => status.threadId))];
  if (threadIds.length === 0) return null;
  return <div data-testid="turn-save-recovery">
    {threadIds.map((threadId) => <div key={threadId}>
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-xs" disabled={retrying.has(threadId)} aria-busy={retrying.has(threadId)}
        onClick={() => { void retrySave(threadId); }}>
        {retrying.has(threadId) ? "Retrying save…" : "Retry save"}
      </Button>
      {errors[threadId] ? <p role="alert" className="px-3 text-xs text-muted-foreground">{errors[threadId]}</p> : null}
    </div>)}
  </div>;
}
