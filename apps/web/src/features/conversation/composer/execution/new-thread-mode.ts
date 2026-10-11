import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import type { ComposerMode } from "./composer-mode";

/**
 * Switches a new thread's workspace mode. The rail and the Overview row both call this, so a pick
 * from either surface is remembered and loads the worktree list the same way.
 */
export function selectNewThreadMode(workspaceId: string | undefined, mode: ComposerMode): void {
  const store = useWorkspaceStore.getState();
  store.setNewThreadMode(mode);
  rememberComposerMode(mode);
  if (mode === "existing-worktree" && workspaceId) store.loadWorktrees(workspaceId);
}

/** A project that is not a git repo can only run Local, whatever mode was remembered. */
export function newThreadComposerMode(isGitRepo: boolean, mode: ComposerMode): ComposerMode {
  return isGitRepo ? mode : "direct";
}
