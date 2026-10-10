import { useMemo } from "react";
import type { ComposerMode } from "@/components/chat/ModeSelector";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { attachedWorktreeFromTarget, isDetachedWorktree, normalizeWorktreePath, type AttachedWorktree } from "@/lib/worktree";
import type { BranchTargetList } from "./BranchTargetPicker";
import { newThreadTargetLabel } from "./new-thread-target-copy";
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

/** One trigger and the picker list it opens. */
export interface TargetPick {
  readonly label: string;
  readonly list: BranchTargetList;
  readonly value: BranchTargetValue | null;
  readonly select: (target: BranchTarget) => void;
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

function unknownBranchLabel(branch: TargetBranch): string {
  return branch.unknown === "loading" ? "Loading branches" : "Choose branch";
}

function branchPick(mode: BranchPickMode, branch: TargetBranch, select: (name: string) => void): TargetPick {
  return {
    label: newThreadTargetLabel({ mode, branch: branch.name }) ?? unknownBranchLabel(branch),
    list: "branches",
    value: branch.name ? { kind: "branch", name: branch.name } : null,
    select: (target) => {
      if (target.kind === "branch") select(target.name);
    },
  };
}

function worktreePick(worktree: AttachedWorktree | null, path: string, select: (worktree: AttachedWorktree) => void): TargetPick {
  return {
    label: newThreadTargetLabel({ mode: "existing-worktree", worktree }) ?? "Choose worktree",
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
function newWorktreePick(branch: TargetBranch, pullRequest: PullRequestSource, selectBranch: (name: string) => void): TargetPick {
  const branchTarget = branchPick("worktree", branch, selectBranch);
  const number = pullRequest.number;
  return {
    label: newThreadTargetLabel({ mode: "worktree", branch: branch.name, pullRequestNumber: number }) ?? unknownBranchLabel(branch),
    list: "branches-and-pull-requests",
    value: number === undefined ? branchTarget.value : { kind: "pull-request", number },
    select: (target) => {
      if (target.kind === "pull-request") pullRequest.select(target.headRefName, target.number);
      else branchTarget.select(target);
    },
  };
}

/** Owns a new thread's target trigger: copy, picker list, selected row, and how a pick lands in the store. */
export function useNewThreadTargetSelection(workspaceId: string | undefined, mode: ComposerMode): ComposerTargetSelectionState {
  const branch = useNewThreadTargetBranch(workspaceId);
  const branchSource = useWorkspaceStore((state) => state.newThreadBranchSource);
  const pullRequestNumber = useWorkspaceStore((state) => state.newThreadPullRequestNumber);
  const selectedWorktree = useWorkspaceStore((state) => state.selectedWorktree);
  const setNewThreadBranch = useWorkspaceStore((state) => state.setNewThreadBranch);
  const setNewThreadBranchFromPr = useWorkspaceStore((state) => state.setNewThreadBranchFromPr);
  const setSelectedWorktree = useWorkspaceStore((state) => state.setSelectedWorktree);
  const base = { workspaceId, contextThreadId: undefined };

  if (mode === "existing-worktree") {
    return {
      ...base,
      target: worktreePick(selectedWorktree, selectedWorktree?.path ?? "", setSelectedWorktree),
      baseBranch: isDetachedWorktree(selectedWorktree) ? branchPick("worktree", branch, setNewThreadBranch) : null,
    };
  }
  if (mode === "worktree") {
    const pullRequest = {
      number: branchSource === "pr" ? pullRequestNumber : undefined,
      select: setNewThreadBranchFromPr,
    };
    return { ...base, target: newWorktreePick(branch, pullRequest, setNewThreadBranch), baseBranch: null };
  }
  return { ...base, target: branchPick("direct", branch, setNewThreadBranch), baseBranch: null };
}

/** Owns a fork's target trigger, listing from the checkout the parent thread runs in. */
export function useForkTargetSelection(sourceThread: ForkSourceThread | undefined, mode: ComposerMode): ComposerTargetSelectionState {
  const branch = useForkTargetBranch(sourceThread);
  const branchWorktreePath = useWorkspaceStore((state) => state.branchWorktreePath);
  const worktrees = useWorkspaceStore((state) => state.worktrees);
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
      target: worktreePick(worktree, branchWorktreePath, (picked) => setBranchWorktreePath(picked.path)),
      baseBranch: isDetachedWorktree(worktree) ? branchPick("worktree", branch, setBranchTargetBranch) : null,
    };
  }
  return { ...base, target: branchPick(mode, branch, setBranchTargetBranch), baseBranch: null };
}
