import { useEffect, useState } from "react";
import type { ReviewComparisonResult, ReviewFileChange } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/** Every uncommitted file in a checkout, or why the list could not be read. */
export type UncommittedFiles =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly files: readonly ReviewFileChange[] }
  | { readonly status: "failed"; readonly message: string };

function describeUnavailable(result: Exclude<ReviewComparisonResult, { status: "ready" }>): string {
  if (result.status === "failed") return result.failure.summary;
  if (result.status === "too-many-files") return `Too many changed files (${result.fileCount})`;
  return "Changes are unavailable for this checkout";
}

/**
 * The uncommitted files of a scope, whatever view Review is showing, refreshed whenever
 * the checkout's `diffRevision` moves. Keeps the previous list while a refresh is in
 * flight so choices do not flicker.
 */
export function useUncommittedFiles(workspaceId: string, threadId: string | null): UncommittedFiles {
  const revision = useDiffStore((store) => store.diffRevisionByScope[threadId ?? workspaceId] ?? 0);
  const [result, setResult] = useState<UncommittedFiles>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    getTransport()
      .getReviewComparison({ workspaceId, view: "uncommitted", threadId: threadId ?? undefined })
      .then(
        (outcome) => {
          if (cancelled) return;
          setResult(
            outcome.status === "ready"
              ? { status: "ready", files: outcome.comparison.files }
              : { status: "failed", message: describeUnavailable(outcome) },
          );
        },
        (error: unknown) => {
          if (!cancelled) setResult({ status: "failed", message: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, threadId, revision]);
  return result;
}
