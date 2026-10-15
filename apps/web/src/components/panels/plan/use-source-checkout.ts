import { useReviewState } from "@/hooks/useReviewState";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** What "Implement in a new worktree" needs to know about the thread's own checkout. */
export interface SourceCheckout {
  /** False for a project that is not a git repository, where a worktree cannot start at a commit. */
  readonly isGitRepo: boolean;
  /** Uncommitted changes exist and stay behind, because the worktree starts from the last commit. */
  readonly isDirty: boolean;
}

/** Reads the review state of the checkout the thread works in. */
export function useSourceCheckout(threadId: string | null): SourceCheckout {
  const workspaceId = useWorkspaceStore((s) => (threadId ? (s.threads.find((thread) => thread.id === threadId)?.workspace_id ?? null) : null));
  const { state, isDirty } = useReviewState(workspaceId, threadId);
  return { isGitRepo: state?.isGitRepo === true, isDirty };
}
