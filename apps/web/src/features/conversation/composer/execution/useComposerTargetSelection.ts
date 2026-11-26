import { useMemo } from "react";
import type { ComposerMode } from "./composer-mode";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { attachedWorktreeFromTarget, isDetachedWorktree, normalizeWorktreePath, type AttachedWorktree } from "@/lib/worktree";
import type { BranchTargetList } from "./BranchTargetPicker";
import { newThreadTargetLabel, placeholderTargetLabel, type TargetLabel } from "./new-thread-target-copy";
import type { BranchTarget, BranchTargetValue } from "./targets/branch-target";
import { useForkTargetBranch, useNewThreadTargetBranch, type ForkSourceThread, type TargetBranch } from "./useTargetBranch";

/** The product flow that owns an execution target. */
export type ComposerTargetScope = "new-thread" | "branch";

/** Props for shared branch and worktree target selection. Rendered only for a git project. */
export type ComposerTargetSelectionProps =
  | {
    scope: "new-thread";
    mode: ComposerMode;
    workspaceId: string | undefined;
  }
  | {
    scope: "branch";
    mode: ComposerMode;
    sourceThread: ForkSourceThread | undefined;
  };

/** The "Start from origin" switch under a New worktree branch list. */
export interface OriginSwitch {
  readonly checked: boolean;
  /** A remote-only origin row has no local branch to start from, so the switch stays on. */
  readonly forced: boolean;
  readonly set: (on: boolean) => void;
}

/** One trigger and the picker list it opens. */
export interface TargetPick {
  readonly label: TargetLabel;
  readonly list: BranchTargetList;
  readonly value: BranchTargetValue | null;
  readonly select: (target: BranchTarget) => void;
  /** Present only where a pick creates a new worktree from a branch. */
  readonly origin?: OriginSwitch;
}

/** State and actions that drive a Composer execution target picker. */
export interface ComposerTargetSelectionState {
  /** Undefined until a project is chosen; nothing is listed without one. */
  readonly workspaceId: string | undefined;
  /** The persisted thread whose checkout decides the current branch; absent for a new thread. */
  readonly contextThreadId: string | undefined;
  readonly target: TargetPick;
  /** The branch a detached worktree starts from; null unless a detached worktree is attached. */
  readonly baseBranch: TargetPick | null;
}

type BranchPickMode = "direct" | "worktree";

function unknownBranchLabel(branch: TargetBranch): TargetLabel {
  return placeholderTargetLabel(branch.unknown === "loading" ? "Loading branches" : "Choose branch");
}

type SelectBranch = (name: string, remote: string | null) => void;

function branchPick(mode: BranchPickMode, branch: TargetBranch, select: SelectBranch): TargetPick {
  return {
    label: newThreadTargetLabel({ mode, branch: branch.name }) ?? unknownBranchLabel(branch),
    list: "branches",
    value: branch.name ? { kind: "branch", name: branch.name } : null,
    select: (target) => {
      if (target.kind === "branch") select(target.name, target.remote);
    },
  };
}

function worktreePick(
  worktree: AttachedWorktree | null,
  path: string,
  select: (worktree: AttachedWorktree) => void,
  placeholder: string,
): TargetPick {
  return {
    label: newThreadTargetLabel({ mode: "existing-worktree", worktree }) ?? placeholderTargetLabel(placeholder),
    list: "worktrees",
    value: path ? { kind: "worktree", path } : null,
    select: (target) => {
      if (target.kind !== "pull-request") select(attachedWorktreeFromTarget(target));
    },
  };
}

interface PullRequestSource {
  readonly number: number | undefined;
  readonly select: (headRefName: string, number: number) => void;
}

/** New worktree also offers pull requests; a picked one names the trigger and the selected row by number. */
function newWorktreePick(
  branch: TargetBranch,
  pullRequest: PullRequestSource,
  selectBranch: SelectBranch,
  origin: OriginSwitch,
): TargetPick {
  const branchTarget = branchPick("worktree", branch, selectBranch);
  const number = pullRequest.number;
  const fromOrigin = number === undefined && origin.checked;
  return {
    origin,
    label: newThreadTargetLabel({
      mode: "worktree",
      branch: branch.name,
      remote: branch.remote,
      pullRequestNumber: number,
      fromOrigin,
    })
      ?? unknownBranchLabel(branch),
    list: "branches-and-pull-requests",
    value: number === undefined ? branchTarget.value : { kind: "pull-request", number },
    select: (target) => {
      if (target.kind === "pull-request") pullRequest.select(target.headRefName, target.number);
      else branchTarget.select(target);
    },
  };
}

/** What a host holds for a new-thread-shaped target: the picks so far, and how a pick changes them. */
export interface NewThreadTargetPicks {
  readonly branch: TargetBranch;
  readonly branchSource: "branch" | "pr";
  /** Set only when `branchSource` is `pr`. */
  readonly pullRequestNumber: number | undefined;
  readonly startFromOrigin: boolean;
  readonly worktree: AttachedWorktree | null;
  readonly selectBranch: SelectBranch;
  readonly selectPullRequest: (headRefName: string, number: number) => void;
  readonly setStartFromOrigin: (on: boolean) => void;
  readonly selectWorktree: (worktree: AttachedWorktree) => void;
  /** Names the Existing worktree trigger until one is picked. */
  readonly worktreePlaceholder?: string;
}

/**
 * Builds a new thread's trigger copy, picker lists, selected rows, and the Start from origin switch from a host's
 * picks. The composer holds them in the workspace store; the move dialog holds its own, so a move never changes a
 * draft.
 */
export function newThreadTargetSelection(
  workspaceId: string | undefined,
  mode: ComposerMode,
  picks: NewThreadTargetPicks,
): ComposerTargetSelectionState {
  const { branch, worktree } = picks;
  const base = { workspaceId, contextThreadId: undefined };

  if (mode === "existing-worktree") {
    return {
      ...base,
      target: worktreePick(worktree, worktree?.path ?? "", picks.selectWorktree, picks.worktreePlaceholder ?? "Choose worktree"),
      baseBranch: isDetachedWorktree(worktree) ? branchPick("worktree", branch, picks.selectBranch) : null,
    };
  }
  if (mode === "worktree") {
    const pullRequest = {
      number: picks.branchSource === "pr" ? picks.pullRequestNumber : undefined,
      select: picks.selectPullRequest,
    };
    const forced = picks.branchSource === "branch" && branch.remote === "origin";
    const origin = { checked: forced || picks.startFromOrigin, forced, set: picks.setStartFromOrigin };
    return { ...base, target: newWorktreePick(branch, pullRequest, picks.selectBranch, origin), baseBranch: null };
  }
  return { ...base, target: branchPick("direct", branch, picks.selectBranch), baseBranch: null };
}

/** Owns a new thread's target trigger: copy, picker list, selected row, and how a pick lands in the store. */
export function useNewThreadTargetSelection(workspaceId: string | undefined, mode: ComposerMode): ComposerTargetSelectionState {
  const branch = useNewThreadTargetBranch(workspaceId);
  const branchSource = useWorkspaceStore((state) => state.newThreadBranchSource);
  const pullRequestNumber = useWorkspaceStore((state) => state.newThreadPullRequestNumber);
  const selectedWorktree = useWorkspaceStore((state) => state.selectedWorktree);
  const startFromOrigin = useWorkspaceStore((state) => state.newThreadStartFromOrigin);
  const setNewThreadStartFromOrigin = useWorkspaceStore((state) => state.setNewThreadStartFromOrigin);
  const setNewThreadBranch = useWorkspaceStore((state) => state.setNewThreadBranch);
  const setNewThreadBranchFromPr = useWorkspaceStore((state) => state.setNewThreadBranchFromPr);
  const setSelectedWorktree = useWorkspaceStore((state) => state.setSelectedWorktree);

  return newThreadTargetSelection(workspaceId, mode, {
    branch,
    branchSource,
    pullRequestNumber,
    startFromOrigin,
    worktree: selectedWorktree,
    selectBranch: setNewThreadBranch,
    selectPullRequest: setNewThreadBranchFromPr,
    setStartFromOrigin: setNewThreadStartFromOrigin,
    selectWorktree: setSelectedWorktree,
  });
}

/** Owns a fork's target trigger, listing from the checkout the parent thread runs in. */
export function useForkTargetSelection(sourceThread: ForkSourceThread | undefined, mode: ComposerMode): ComposerTargetSelectionState {
  const branch = useForkTargetBranch(sourceThread);
  const branchWorktreePath = useWorkspaceStore((state) => state.branchWorktreePath);
  const worktrees = useWorkspaceStore((state) => state.worktreeListing.worktrees);
  const setBranchTargetBranch = useWorkspaceStore((state) => state.setBranchTargetBranch);
  const setBranchWorktreePath = useWorkspaceStore((state) => state.setBranchWorktreePath);
  const worktree = useMemo(() => {
    const normalizedPath = normalizeWorktreePath(branchWorktreePath);
    return worktrees.find((candidate) => normalizeWorktreePath(candidate.path) === normalizedPath) ?? null;
  }, [branchWorktreePath, worktrees]);
  const base = { workspaceId: sourceThread?.workspace_id, contextThreadId: sourceThread?.id };

  if (mode === "existing-worktree") {
    return {
      ...base,
      target: worktreePick(worktree, branchWorktreePath, (picked) => setBranchWorktreePath(picked.path), "Choose worktree"),
      baseBranch: isDetachedWorktree(worktree) ? branchPick("worktree", branch, setBranchTargetBranch) : null,
    };
  }
  return { ...base, target: branchPick(mode, branch, setBranchTargetBranch), baseBranch: null };
}
