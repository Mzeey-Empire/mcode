import { useEffect, useState } from "react";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

// A selection mounts several readers of the same checkout at once (Review
// header, commit button, plan commands). Each server probe spawns about six
// git processes, and on Windows each spawn blocks the server's event loop
// ahead of the transcript the user is opening. Readers that ask with the same
// key while a probe is in flight share it. The key carries the diff revision,
// so a change the client knows about always starts a new probe, and nothing is
// kept once the probe settles.
const inFlightProbes = new Map<string, Promise<ReviewState>>();

function probeReviewState(key: string, workspaceId: string, threadId: string | undefined): Promise<ReviewState> {
  const pending = inFlightProbes.get(key);
  if (pending) return pending;
  const probe = getTransport().getReviewState(workspaceId, threadId);
  inFlightProbes.set(key, probe);
  const release = () => {
    if (inFlightProbes.get(key) === probe) inFlightProbes.delete(key);
  };
  probe.then(release, release);
  return probe;
}

/** Refresh Review availability and dirty state on checkout revisions and menu opens. */
export function useReviewState(workspaceId: string | null, threadId?: string | null, refresh = 0) {
  const revision = useDiffStore((store) => store.diffRevisionByScope[threadId ?? workspaceId ?? ""] ?? 0);
  const key = JSON.stringify([workspaceId, threadId, revision, refresh]);
  const [result, setResult] = useState<{ key: string; state: ReviewState | null; error: unknown } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void probeReviewState(key, workspaceId, threadId ?? undefined).then(
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
