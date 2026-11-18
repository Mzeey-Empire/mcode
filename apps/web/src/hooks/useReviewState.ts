import { useEffect, useState } from "react";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";
import { getTransport } from "@/transport";
import { selectDiffRevision, useDiffStore } from "@/stores/diffStore";

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

/**
 * Stop sharing probes that started before HEAD moved. A reader that mounts
 * from now on starts its own probe, so it never answers for the old HEAD.
 */
export function forgetInFlightReviewProbes(): void {
  inFlightProbes.clear();
}

/** Refresh Review availability and dirty state on checkout revisions and menu opens. */
export function useReviewState(workspaceId: string | null, threadId?: string | null, refresh = 0) {
  const revision = useDiffStore((store) => selectDiffRevision(store, threadId ?? workspaceId ?? ""));
  const checkout = JSON.stringify([workspaceId, threadId]);
  const key = JSON.stringify([workspaceId, threadId, revision, refresh]);
  const [result, setResult] = useState<{ checkout: string; state: ReviewState | null; error: unknown } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void probeReviewState(key, workspaceId, threadId ?? undefined).then(
      (state) => { if (!cancelled) setResult({ checkout, state, error: null }); },
      (error: unknown) => { if (!cancelled) setResult({ checkout, state: null, error }); },
    );
    return () => { cancelled = true; };
  }, [workspaceId, threadId, checkout, key]);
  // A refresh keeps the checkout's last answer until the new one lands, so controls that depend on it, such as
  // Review's Commit button, do not vanish and return on every revision.
  const current = workspaceId && result?.checkout === checkout ? result : null;
  const state = current?.state ?? null;
  return { state, isDirty: hasUncommittedChanges(state), error: current?.error ?? null };
}

function hasUncommittedChanges(state: ReviewState | null): boolean {
  if (!state?.isGitRepo) return false;
  const { staged, unstaged, untracked } = state.uncommitted;
  return staged + unstaged + untracked > 0;
}
