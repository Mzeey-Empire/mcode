import { useEffect, useState } from "react";
import type { ReviewState } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/** Refresh Review availability and dirty state on checkout revisions and menu opens. */
export function useReviewState(workspaceId: string | null, threadId?: string | null, refresh = 0) {
  const revision = useDiffStore((store) => store.diffRevisionByScope[threadId ?? workspaceId ?? ""] ?? 0);
  const key = JSON.stringify([workspaceId, threadId, revision, refresh]);
  const [result, setResult] = useState<{ key: string; state: ReviewState | null; error: unknown } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void getTransport().getReviewState(workspaceId, threadId ?? undefined).then(
      (state) => { if (!cancelled) setResult({ key, state, error: null }); },
      (error: unknown) => { if (!cancelled) setResult({ key, state: null, error }); },
    );
    return () => { cancelled = true; };
  }, [workspaceId, threadId, key]);
  const state = workspaceId && result?.key === key ? result.state : null;
  const counts = state?.isGitRepo ? state.uncommitted : null;
  return {
    state,
    isDirty: counts !== null && counts.staged + counts.unstaged + counts.untracked > 0,
    error: result?.key === key ? result.error : null,
  };
}
