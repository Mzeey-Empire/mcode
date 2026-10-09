import { isDetachedWorktree, type AttachedWorktree } from "@/lib/worktree";

/** What a new thread's target trigger names, per composer mode. */
export type NewThreadTargetCopyInput =
  | { readonly mode: "worktree"; readonly branch: string; readonly pullRequestNumber?: number }
  | { readonly mode: "direct"; readonly branch: string }
  | { readonly mode: "existing-worktree"; readonly worktree: AttachedWorktree | null };

/**
 * Trigger copy for a new thread's target: "From main", "From #1804", "On main", or "On {branch}" and the folder
 * of a detached worktree. Null when nothing is chosen yet, so the caller says why instead of guessing a name.
 */
export function newThreadTargetLabel(input: NewThreadTargetCopyInput): string | null {
  if (input.mode === "existing-worktree") {
    if (!input.worktree) return null;
    return isDetachedWorktree(input.worktree) ? input.worktree.name : `On ${input.worktree.branch}`;
  }
  if (input.mode === "direct") return input.branch ? `On ${input.branch}` : null;
  if (input.pullRequestNumber !== undefined) return `From #${input.pullRequestNumber}`;
  return input.branch ? `From ${input.branch}` : null;
}
