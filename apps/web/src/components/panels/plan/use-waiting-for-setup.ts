import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { usePlanStore } from "@/stores/planStore";

/** A new-worktree Implement that is holding the source plan until the target's Setup finishes. */
export interface PlanWaitingForSetup {
  readonly targetThreadId: string;
  /** The worktree folder's name, or null before the thread row carries its path. */
  readonly folder: string | null;
}

/**
 * Reads the server's held Implement for the source thread, so a reload or a second client shows the
 * same read-only state the requesting window does. The server ends it on admission, failure or Stop.
 */
export function useWaitingForSetup(threadId: string): PlanWaitingForSetup | null {
  const pending = usePlanStore((s) => s.pendingImplementByThread[threadId] ?? null);
  const target = useWorkspaceStore((s) => (pending ? s.threads.find((thread) => thread.id === pending.targetThreadId) ?? null : null));
  if (!pending) return null;
  const segments = target?.worktree_path?.split(/[\\/]/).filter(Boolean);
  return { targetThreadId: pending.targetThreadId, folder: segments?.at(-1) ?? null };
}
