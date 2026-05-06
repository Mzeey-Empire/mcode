import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";

/**
 * Format an ISO timestamp as a short relative time string (e.g. "2h ago").
 * Returns "just now" for timestamps within the last minute.
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

/**
 * Summary tab content for the diff panel.
 *
 * Three states:
 * - Empty: prompt to generate a summary with a CTA button
 * - Loading: spinner while the summary is being generated
 * - Rendered: markdown content with metadata and a regenerate button
 */
export function SummaryView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  // Only count snapshots that actually have file changes
  const hasFileChanges = snapshots?.some((s) => s.files_changed.length > 0) ?? false;

  const summaryRecord = useDiffStore((s) => s.summaryRecord);
  const summaryLoading = useDiffStore((s) => s.summaryLoading);
  const setSummaryRecord = useDiffStore((s) => s.setSummaryRecord);
  const setSummaryLoading = useDiffStore((s) => s.setSummaryLoading);

  const [error, setError] = useState<string | null>(null);

  // Compute staleness: count turns with file changes that arrived after the summary's lastTurnId
  const newTurnCount = (() => {
    if (!summaryRecord || !snapshots || !summaryRecord.lastTurnId) return 0;
    const lastIdx = snapshots.findIndex(
      (s) => s.message_id === summaryRecord.lastTurnId,
    );
    if (lastIdx === -1) return 0;
    return snapshots
      .slice(lastIdx + 1)
      .filter((s) => s.files_changed.length > 0).length;
  })();

  // Load persisted summary on mount or when the thread changes
  useEffect(() => {
    setError(null);
    if (!activeThreadId) return;
    if (summaryRecord?.threadId === activeThreadId) return;

    let cancelled = false;

    const load = async () => {
      try {
        const result = await getTransport().getDiffSummary(activeThreadId);
        if (!cancelled) setSummaryRecord(result);
      } catch (err) {
        if (cancelled) return;
        setSummaryRecord(null);
        setError(err instanceof Error ? err.message : "Failed to load summary");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, summaryRecord?.threadId, setSummaryRecord]);

  const handleGenerate = useCallback(async () => {
    if (!activeThreadId) return;
    const requestThreadId = activeThreadId;
    setError(null);
    setSummaryLoading(true);
    try {
      const result = await getTransport().generateDiffSummary(requestThreadId);
      // Ignore stale responses if the user switched threads during generation
      if (useWorkspaceStore.getState().activeThreadId !== requestThreadId) return;
      setSummaryRecord(result);
    } catch (err) {
      if (useWorkspaceStore.getState().activeThreadId !== requestThreadId) return;
      const message = err instanceof Error ? err.message : "Failed to generate summary";
      setError(message);
    } finally {
      setSummaryLoading(false);
    }
  }, [activeThreadId, setSummaryLoading, setSummaryRecord]);

  // Loading state — three-dot pulse matching sibling diff views
  if (summaryLoading) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-14"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex items-center gap-1.5">
          {[0, 150, 300].map((delay) => (
            <div
              key={delay}
              className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/40">
          Summarizing
        </span>
      </div>
    );
  }

  // Rendered state
  if (summaryRecord && summaryRecord.threadId === activeThreadId) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {newTurnCount > 0 && (
          <div className="flex items-center justify-between border-b border-border/30 pb-2">
            <span className="font-mono text-[10.5px] text-muted-foreground/60">
              {newTurnCount} new {newTurnCount === 1 ? "turn" : "turns"} since summary
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleGenerate}
              className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RefreshCw size={12} />
              Regenerate
            </Button>
          </div>
        )}

        <div className="prose prose-sm dark:prose-invert text-[13px] leading-relaxed">
          <MarkdownContent content={summaryRecord.content} />
        </div>

        <div className="flex items-center justify-between border-t border-border/30 pt-3">
          <span className="text-[11px] text-muted-foreground">
            {summaryRecord.model} · {relativeTime(summaryRecord.createdAt)} · {summaryRecord.turnCount}{" "}
            {summaryRecord.turnCount === 1 ? "turn" : "turns"}
          </span>
          {newTurnCount === 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleGenerate}
              className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RefreshCw size={12} />
              Regenerate
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Empty state — glyph + mono small-caps matching sibling diff views
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-14">
      <span className="font-mono text-[28px] leading-none text-muted-foreground/15">Σ</span>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
        No summary
      </span>
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        onClick={handleGenerate}
        disabled={!hasFileChanges || !activeThreadId}
        className="mt-1 text-[11px] text-muted-foreground/50 hover:text-foreground"
        title={!hasFileChanges ? "No file changes to summarize" : undefined}
      >
        Generate
      </Button>
    </div>
  );
}
