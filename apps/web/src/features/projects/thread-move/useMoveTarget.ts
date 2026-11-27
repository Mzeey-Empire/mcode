import { useEffect, useState } from "react";
import type { Workspace } from "@mcode/contracts/models/workspace";
import type { ThreadMoveInput } from "@mcode/contracts/ws/methods";
import type { ComposerMode } from "@/features/conversation/composer/execution/composer-mode";
import { revalidateBranchTargets, useBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { useEffectiveBranch, type TargetBranch } from "@/features/conversation/composer/execution/useTargetBranch";
import {
  newThreadTargetSelection,
  type ComposerTargetSelectionState,
} from "@/features/conversation/composer/execution/useComposerTargetSelection";
import type { UnavailableMode } from "@/features/conversation/composer/execution/WorkspaceTargetMenu";
import { readRememberedStartFromOrigin } from "@/lib/start-from-origin-preference";
import { isDetachedWorktree, type AttachedWorktree } from "@/lib/worktree";

export type MoveTarget = ThreadMoveInput["target"];

interface MovePicks {
  readonly mode: ComposerMode;
  readonly branch: string;
  readonly branchRemote: string | null;
  readonly branchSource: "branch" | "pr";
  readonly pullRequestNumber: number | undefined;
  readonly startFromOrigin: boolean;
  readonly worktree: AttachedWorktree | null;
}

const NO_PICKS: MovePicks = {
  mode: "direct",
  branch: "",
  branchRemote: null,
  branchSource: "branch",
  pullRequestNumber: undefined,
  startFromOrigin: false,
  worktree: null,
};

const NO_WORKTREES: UnavailableMode = { status: "None yet", reason: "This project has no worktrees" };

export interface MoveTargetState {
  readonly mode: ComposerMode;
  readonly setMode: (mode: ComposerMode) => void;
  readonly selection: ComposerTargetSelectionState;
  readonly unavailable: Readonly<Partial<Record<ComposerMode, UnavailableMode>>>;
  /** Null until the picks name everything the server needs, such as a worktree or a base branch. */
  readonly request: MoveTarget | null;
}

function initialPicks(workspaceId: string | undefined): MovePicks {
  return { ...NO_PICKS, startFromOrigin: readRememberedStartFromOrigin(workspaceId ?? null) };
}

/** The picks for one project. Choosing another project starts them over, so a worktree path never crosses projects. */
function useMovePicks(workspaceId: string | undefined): { readonly picks: MovePicks; readonly update: (change: Partial<MovePicks>) => void } {
  const [held, setHeld] = useState<{ readonly workspaceId: string | undefined; readonly picks: MovePicks }>(() => ({ workspaceId, picks: initialPicks(workspaceId) }));
  const picksFor = (state: typeof held) => (state.workspaceId === workspaceId ? state.picks : initialPicks(workspaceId));
  const update = (change: Partial<MovePicks>) => setHeld((previous) => ({ workspaceId, picks: { ...picksFor(previous), ...change } }));
  return { picks: picksFor(held), update };
}

function useHasNoWorktrees(workspaceId: string | undefined): boolean {
  const worktrees = useBranchTargets(workspaceId ? { workspaceId, purpose: "existing-worktree" } : null);
  // A worktree made outside Mcode pushes no event, and "None yet" disables the row whose picker would otherwise
  // refetch on open, so a cached empty list must be reread whenever a project is picked.
  useEffect(() => {
    if (workspaceId) revalidateBranchTargets({ workspaceId, purpose: "existing-worktree" });
  }, [workspaceId]);
  return worktrees.status.kind === "ready" && worktrees.items.length === 0;
}

/**
 * The picks for the destination project, kept apart from the new-thread draft so opening the dialog never
 * changes it.
 */
export function useMoveTarget(workspace: Workspace | undefined): MoveTargetState {
  const gitWorkspaceId = workspace?.is_git_repo ? workspace.id : undefined;
  const { picks, update } = useMovePicks(workspace?.id);
  const branch = useEffectiveBranch(picks.branch, picks.branchRemote, gitWorkspaceId ? { workspaceId: gitWorkspaceId } : null);
  const selection = newThreadTargetSelection(workspace?.id, picks.mode, {
    branch,
    branchSource: picks.branchSource,
    pullRequestNumber: picks.pullRequestNumber,
    startFromOrigin: picks.startFromOrigin,
    worktree: picks.worktree,
    worktreePlaceholder: "Choose a worktree",
    selectBranch: (name, remote) => update({ branch: name, branchRemote: remote, branchSource: "branch", pullRequestNumber: undefined }),
    selectPullRequest: (headRefName, number) =>
      update({ branch: headRefName, branchRemote: null, branchSource: "pr", pullRequestNumber: number }),
    setStartFromOrigin: (on) => update({ startFromOrigin: on }),
    selectWorktree: (worktree) => update({ worktree }),
  });
  const noWorktrees = useHasNoWorktrees(gitWorkspaceId);

  return {
    mode: picks.mode,
    setMode: (mode) => update({ mode }),
    selection,
    unavailable: noWorktrees ? { "existing-worktree": NO_WORKTREES } : {},
    request: moveTargetRequest(picks, branch, selection.target.origin?.checked ?? false),
  };
}

/** The remote-only ref `origin/x` names the branch `x` to the server, as it does for a new thread. */
function withoutRemote(branch: TargetBranch): string {
  const prefix = branch.remote ? `${branch.remote}/` : null;
  return prefix && branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}

function existingWorktreeRequest(worktree: AttachedWorktree | null, branch: TargetBranch): MoveTarget | null {
  if (!worktree) return null;
  if (!isDetachedWorktree(worktree)) return { kind: "existing-worktree", worktreePath: worktree.path };
  // A detached worktree has no branch of its own, so the move records the base branch the user picked.
  return branch.name ? { kind: "existing-worktree", worktreePath: worktree.path, baseBranch: branch.name } : null;
}

function newWorktreeRequest(picks: MovePicks, branch: TargetBranch, fromOrigin: boolean): MoveTarget | null {
  if (!branch.name) return null;
  if (picks.branchSource === "pr") {
    const { pullRequestNumber } = picks;
    return pullRequestNumber === undefined
      ? null
      : { kind: "new-worktree", source: { kind: "pr", branch: branch.name, pullRequestNumber } };
  }
  return {
    kind: "new-worktree",
    source: { kind: "branch", baseBranch: fromOrigin ? withoutRemote(branch) : branch.name, startFromOrigin: fromOrigin },
  };
}

function moveTargetRequest(picks: MovePicks, branch: TargetBranch, fromOrigin: boolean): MoveTarget | null {
  switch (picks.mode) {
    case "direct":
      return { kind: "local" };
    case "existing-worktree":
      return existingWorktreeRequest(picks.worktree, branch);
    case "worktree":
      return newWorktreeRequest(picks, branch, fromOrigin);
    default:
      throw new Error(`Unhandled composer mode: ${picks.mode satisfies never}`);
  }
}
