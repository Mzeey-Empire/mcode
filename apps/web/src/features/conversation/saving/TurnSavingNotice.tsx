import type { TurnSavingStatus } from "@mcode/contracts";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getTransport } from "@/transport";

/** Shows storage health without blocking an ordinary running or completed response. */
export function TurnSavingNotice({ statuses, lostProgress, parentConversation = false }: { statuses: readonly TurnSavingStatus[]; lostProgress: boolean; parentConversation?: boolean }) {
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
    } catch (error) {
      setErrors((previous) => ({ ...previous, [threadId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      inFlight.current.delete(threadId);
      setRetrying(new Set(inFlight.current));
    }
  };
  const pending = statuses.filter((status) => status.mode !== "durable" && status.mode !== "saving-delayed");
  if (pending.length === 0 && !lostProgress) return null;
  return <div className="mx-3 mb-2 space-y-1 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground" data-testid="turn-saving-notice">
    {lostProgress ? <p role="alert">Mcode restarted. Progress that had not been saved was lost.</p> : null}
    {pending.map((status) => <SavingLine key={status.executionId} status={status} parentConversation={parentConversation} retrying={retrying.has(status.threadId)}
      error={errors[status.threadId]} onRetry={() => { void retrySave(status.threadId); }} />)}
  </div>;
}

function savingCopy(parentConversation: boolean) {
  return parentConversation ? { saving: "Saving parent conversation…", failed: "Parent conversation could not be saved." }
    : { saving: "Saving response…", failed: "Response could not be saved." };
}

function SavingLine({ status, retrying, error, onRetry, parentConversation }: { status: TurnSavingStatus; retrying: boolean; error?: string; onRetry: () => void; parentConversation: boolean }) {
  const copy = savingCopy(parentConversation);
  switch (status.mode) {
    case "saving": return <p role="status">{copy.saving}</p>;
    case "save-retrying": return <p role="status">Retrying save. {status.failure.message}</p>;
    case "saving-failed": return <div className="flex items-start justify-between gap-3">
      <div><p role="alert">{copy.failed} {status.failure.message}</p>
        {error ? <p role="alert">Retry failed. {error}</p> : null}</div>
      <Button type="button" variant="outline" size="sm" disabled={retrying} aria-busy={retrying} onClick={onRetry}>
        {retrying ? "Retrying save…" : "Retry save"}
      </Button>
    </div>;
    case "unsaved": return <p role="status">Response is visible but has not been saved. A restart can lose it.</p>;
    case "stopping": return <p role="status">Stopping safely…</p>;
    case "durable":
    case "saving-delayed": return null;
  }
}
