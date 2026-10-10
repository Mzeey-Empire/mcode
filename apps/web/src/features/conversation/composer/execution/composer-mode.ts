import type { ComponentType } from "react";
import { Folder, Laptop } from "lucide-react";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";

/**
 * Where the next thread runs.
 * - "direct": Local, in the project folder
 * - "worktree": a new git worktree
 * - "existing-worktree": a worktree the project already has
 */
export type ComposerMode = "direct" | "worktree" | "existing-worktree";

/** One workspace choice: its menu name and icon. */
export interface ComposerModeOption {
  readonly mode: ComposerMode;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
}

/** Each mode's menu name and icon (`20LL-2`). */
export const COMPOSER_MODE_OPTIONS: Readonly<Record<ComposerMode, ComposerModeOption>> = {
  worktree: { mode: "worktree", label: "New worktree", Icon: WorktreeModeIcon },
  "existing-worktree": { mode: "existing-worktree", label: "Existing worktree", Icon: Folder },
  direct: { mode: "direct", label: "Local", Icon: Laptop },
};

/** Workspace menu order (`20LL-2`). A project that is not a git repo offers only Local. */
export function composerModeOptions(isGitRepo: boolean): readonly ComposerModeOption[] {
  if (!isGitRepo) return [COMPOSER_MODE_OPTIONS.direct];
  return [COMPOSER_MODE_OPTIONS.worktree, COMPOSER_MODE_OPTIONS["existing-worktree"], COMPOSER_MODE_OPTIONS.direct];
}
