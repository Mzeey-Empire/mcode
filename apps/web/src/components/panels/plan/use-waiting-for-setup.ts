import type { PlanVersion } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { usePlanImplementStore } from "./plan-implement";

/** A new-worktree Implement that is holding the source plan until the target's Setup finishes. */
export interface PlanWaitingForSetup {
  readonly targetThreadId: string;
  /** The worktree folder's name, or null before the thread row carries its path. */
  readonly folder: string | null;
}

/**
 * Derives the waiting state instead of storing an end for it: the request stops waiting when its
 * version reads Accepted, or when Stop deletes the empty target thread. Neither needs a push of its own.
 */
export function useWaitingForSetup(threadId: string, latest: PlanVersion | null): PlanWaitingForSetup | null {
  const entry = usePlanImplementStore((s) => s.waiting[threadId] ?? null);
  const target = useWorkspaceStore((s) => (entry ? s.threads.find((thread) => thread.id === entry.targetThreadId) ?? null : null));
  if (!entry || !target || latest?.status === "accepted") return null;
  const segments = target.worktree_path?.split(/[\\/]/).filter(Boolean);
  return { targetThreadId: entry.targetThreadId, folder: segments?.at(-1) ?? null };
}
