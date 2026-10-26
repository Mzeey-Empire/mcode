import { isDetachedWorktree, type AttachedWorktree } from "@/lib/worktree";

/** What a new thread's target trigger names, per composer mode. */
export type NewThreadTargetCopyInput =
  | {
    readonly mode: "worktree";
    readonly branch: string;
    readonly pullRequestNumber?: number;
    /** Remote of a remote-only ref, such as `origin` for `origin/x`. */
    readonly remote?: string | null;
    /** Names the branch as the fetched remote copy the worktree starts from. */
    readonly fromOrigin?: boolean;
  }
  | { readonly mode: "direct"; readonly branch: string }
  | { readonly mode: "existing-worktree"; readonly worktree: AttachedWorktree | null };

/**
 * Target copy split into a relation verb and the thing it names, so the rail can print it as one phrase and
 * the Overview can emphasize the name. A null prefix means the name stands alone, as a detached worktree's
 * folder or a placeholder does.
 */
export interface TargetLabel {
  readonly prefix: "From" | "On" | null;
  readonly name: string;
}

/**
 * Trigger copy for a new thread's target: "From main", "From main (remote)", "From #1804", "On main", or "On {branch}" and the folder
 * of a detached worktree. Null when nothing is chosen yet, so the caller says why instead of guessing a name.
 */
export function newThreadTargetLabel(input: NewThreadTargetCopyInput): TargetLabel | null {
  if (input.mode === "existing-worktree") {
    if (!input.worktree) return null;
    return isDetachedWorktree(input.worktree)
      ? { prefix: null, name: input.worktree.name }
      : { prefix: "On", name: input.worktree.branch };
  }
  if (input.mode === "direct") return input.branch ? { prefix: "On", name: input.branch } : null;
  if (input.pullRequestNumber !== undefined) return { prefix: "From", name: `#${input.pullRequestNumber}` };
  if (!input.branch) return null;
  if (!input.fromOrigin) return { prefix: "From", name: input.branch };
  const shortName = input.remote ? input.branch.slice(input.remote.length + 1) : input.branch;
  return { prefix: "From", name: `${shortName} (remote)` };
}

/** A label with no relation verb, for placeholders such as "Choose branch". */
export function placeholderTargetLabel(name: string): TargetLabel {
  return { prefix: null, name };
}

/** The label as one phrase, the way the rail trigger prints it. */
export function targetLabelText(label: TargetLabel): string {
  return label.prefix ? `${label.prefix} ${label.name}` : label.name;
}

/**
 * Meta beside a new thread's workspace name: "Create" for a new worktree, the project folder for Local,
 * and the attached worktree's folder for an existing worktree. Null until an existing worktree is chosen.
 */
export function newThreadWorkspaceMeta(
  mode: NewThreadTargetCopyInput["mode"],
  folder: string,
  worktree: AttachedWorktree | null,
): string | null {
  if (mode === "worktree") return "Create";
  if (mode === "direct") return folder;
  return worktree?.name ?? null;
}
