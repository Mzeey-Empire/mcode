import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { FileList } from "./FileList";

/** Props for CumulativeView. */
interface CumulativeViewProps {
  snapshots: TurnSnapshot[];
  threadId: string;
}

/** Deduplicated file list across all snapshots for the "All" cumulative view. */
export function CumulativeView({ snapshots, threadId }: CumulativeViewProps) {
  const pending = useDiffStore((s) => s.snapshotsPendingByThread[threadId] ?? false);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const markSnapshotsPending = useDiffStore((s) => s.markSnapshotsPending);
  const [refreshing, setRefreshing] = useState(false);

  const files = useMemo(() => {
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      for (const file of snapshot.files_changed) {
        seen.add(file);
      }
    }
    return [...seen].sort();
  }, [snapshots]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await getTransport().listSnapshots(threadId);
      setSnapshots(threadId, result);
    } catch {
      // Best-effort refresh; leave the pending flag so the user can retry.
      markSnapshotsPending(threadId, true);
    } finally {
      setRefreshing(false);
    }
  };

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
        <span aria-hidden="true" className="font-mono text-[28px] leading-none text-muted-foreground/15">
          ⊘
        </span>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
          No changes yet
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/15">
        <span className="font-mono text-[11px] tabular-nums text-foreground/70">
          {files.length}
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/55">
          file{files.length !== 1 ? "s" : ""} · {snapshots.length} turn{snapshots.length !== 1 ? "s" : ""}
        </span>
        {pending && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="New changes available — click to refresh"
            data-testid="cumulative-view-refresh"
            className="ml-auto gap-1.5 rounded border-primary/40 bg-primary/15 px-2.5 py-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-primary hover:border-primary/60 hover:bg-primary/25"
          >
            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
            New changes
          </Button>
        )}
      </div>
      <FileList files={files} source="cumulative" id={threadId} threadId={threadId} />
    </div>
  );
}
