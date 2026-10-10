import { useState, useCallback } from "react";
import type { ReviewFileDiffResult } from "@mcode/contracts";
import { ChevronRight, FileText } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import { getTransport } from "@/transport";
import { useShikiTheme } from "@/hooks/useTheme";

/** Number of lines to request on the initial (truncated) fetch. */
const MAX_LINES = 500;

/** Props for the DiffViewer component. */
interface DiffViewerProps {
  snapshotId: string;
  filePath: string;
  changeType?: "created" | "deleted" | "renamed" | "modified" | "binary";
}

/**
 * Inline diff for one file inside the transcript. Lazy-loads the patch on
 * expand and renders it through pierre's PatchDiff.
 */
export function DiffViewer({ snapshotId, filePath, changeType = "modified" }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const shikiTheme = useShikiTheme();

  const handleToggle = useCallback(async () => {
    if (!expanded && diff === null) {
      setLoading(true);
      try {
        const result = await getTransport().getSnapshotDiff(snapshotId, filePath, MAX_LINES);
        if (typeof result === "string") {
          setDiff(result);
          setTruncated(result.split("\n").length > MAX_LINES);
        } else {
          setUnavailable(unavailableDiffLabel(result));
          setDiff("");
        }
      } catch {
        setDiff("");
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  }, [expanded, diff, snapshotId, filePath]);

  /** Re-fetch the diff without a line cap so the user sees the complete output. */
  const handleShowAll = useCallback(async () => {
    try {
      const fullDiff = await getTransport().getSnapshotDiff(snapshotId, filePath);
      // Keep the truncated diff when the full one is no longer available.
      if (typeof fullDiff !== "string") return;
      setDiff(fullDiff);
      setTruncated(false);
    } catch {
      // Keep existing truncated diff on error
    }
  }, [snapshotId, filePath]);

  const changeLabel = {
    created: "File created",
    deleted: "File deleted",
    renamed: "File renamed",
    modified: "Modified",
    binary: "Binary file changed",
  }[changeType];

  return (
    <div className="overflow-hidden rounded-md border border-border/30">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 bg-hover/20 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-hover/40"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <FileText className="h-3 w-3 shrink-0" />
        <span className="text-fade font-mono">{filePath}</span>
        <span className="ml-auto text-xs opacity-60">{changeLabel}</span>
        {loading && <span className="text-xs">Loading...</span>}
      </button>
      {expanded ? (
        <DiffBody
          binary={changeType === "binary"}
          diff={diff}
          unavailable={unavailable}
          truncated={truncated}
          shikiTheme={shikiTheme}
          onShowAll={handleShowAll}
        />
      ) : null}
    </div>
  );
}

/** Expanded body: binary notice, patch render, or the show-all affordance. */
function DiffBody({
  binary,
  diff,
  unavailable,
  truncated,
  shikiTheme,
  onShowAll,
}: {
  readonly binary: boolean;
  readonly diff: string | null;
  readonly unavailable: string | null;
  readonly truncated: boolean;
  readonly shikiTheme: string;
  readonly onShowAll: () => void;
}) {
  if (binary) {
    return (
      <div className="px-3 py-2 text-xs text-muted/70">
        Binary file changed. No diff available.
      </div>
    );
  }
  if (diff === null) return null;
  if (unavailable) return <p className="px-3 py-2 text-xs text-muted/70">{unavailable}</p>;
  return (
    <div className="max-h-[500px] overflow-auto">
      {diff ? (
        <PatchDiff
          patch={diff}
          options={{ theme: shikiTheme, diffStyle: "unified", overflow: "scroll" }}
        />
      ) : (
        <p className="px-3 py-2 text-xs text-muted/70">No diff content</p>
      )}
      {truncated ? (
        <button
          type="button"
          onClick={onShowAll}
          className="w-full bg-hover/20 py-1.5 text-center text-xs text-muted/70 hover:text-ink"
        >
          Show full diff
        </button>
      ) : null}
    </div>
  );
}

/** Name why a snapshot patch is missing, so an unavailable diff never reads as an empty one. */
function unavailableDiffLabel(result: Exclude<ReviewFileDiffResult, string>): string {
  switch (result.status) {
    case "failed":
      return result.failure.summary;
    case "too-many-files":
      return "Too many files to show";
    case "unavailable":
      return result.reason === "snapshot-expired" || result.reason === "snapshot-pruned"
        ? "This turn's changes are gone"
        : "No diff available";
  }
}
