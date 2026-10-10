import { useCallback, useEffect, useMemo } from "react";
import { ALL_MODE_OPTIONS, type ComposerMode, type ModeOption } from "@/components/chat/ModeSelector";
import type { Thread } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { isDetachedWorktree, normalizeWorktreePath } from "@/lib/worktree";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import { useForkTargetBranch, useNewThreadTargetBranch, type TargetBranch } from "./useTargetBranch";

/** The selected execution target for the current Composer session. */
export type ComposerExecutionTarget =
  | {
    kind: "new-thread";
    mode: ComposerMode;
    branch: string;
    branchSource: "branch" | "pr";
    pullRequestNumber?: number;
    hasWorktree: boolean;
  }
  | {
    kind: "branch";
    mode: ComposerMode;
    branch: string;
    worktreePath: string | null;
    worktreeIsDetached: boolean;
  }
  | {
    kind: "existing-thread";
    mode: ComposerMode;
  };

/** Inputs that identify the Composer execution flow. */
export interface UseComposerExecutionTargetOptions {
  activeThread?: Thread;
  branchFromMessageId?: string;
  isNewThread: boolean;
  workspaceId?: string;
}

/** Execution target state and operations for new-thread, branch, and existing-thread Composer flows. */
export interface ComposerExecutionTargetController {
  target: ComposerExecutionTarget;
  mode: ComposerMode;
  modeOptions: ModeOption[];
  isGitRepo: boolean;
  needsWorkspace: boolean;
  isStaleWorktree: boolean;
  workspacePath?: string;
  selectedWorktree: ReturnType<typeof useWorkspaceStore.getState>["selectedWorktree"];
  newThreadBranch: string;
  newThreadBranchSource: "branch" | "pr";
  branchExecMode: ComposerMode;
  branchTargetBranch: string;
  branchWorktreePath: string | null;
  branchWorktreeIsDetached: boolean;
  /**
   * True while a new thread or fork in a git project has no branch to send: nothing is picked and the default is
   * still loading or could not be read. Send waits instead of guessing a branch name.
   */
  targetPending: boolean;
  setMode(mode: ComposerMode): void;
  setBranchMode(mode: ComposerMode): void;
  setNewThreadMode(mode: ComposerMode): void;
  setNewThreadBranch(branch: string): void;
  setNewThreadBranchFromPullRequest(branch: string, pullRequestNumber: number): void;
}

/** Owns the Composer execution target selection and its workspace data lifecycle. */
export function useComposerExecutionTarget({
  activeThread,
  branchFromMessageId,
  isNewThread,
  workspaceId,
}: UseComposerExecutionTargetOptions): ComposerExecutionTargetController {
  const activeWorkspace = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId),
  );
  const newThreadMode = useWorkspaceStore((state) => state.newThreadMode);
  const newThreadBranchSource = useWorkspaceStore((state) => state.newThreadBranchSource);
  const newThreadPullRequestNumber = useWorkspaceStore((state) => state.newThreadPullRequestNumber);
  const selectedWorktree = useWorkspaceStore((state) => state.selectedWorktree);
  const branchExecMode = useWorkspaceStore((state) => state.branchExecMode);
  const branchWorktreePath = useWorkspaceStore((state) => state.branchWorktreePath);
  const worktrees = useWorkspaceStore((state) => state.worktrees);
  const worktreesLoadedForWorkspace = useWorkspaceStore((state) => state.worktreesLoadedForWorkspace);
  const loadWorktrees = useWorkspaceStore((state) => state.loadWorktrees);
  const initBranchMode = useWorkspaceStore((state) => state.initBranchMode);
  const setBranchExecMode = useWorkspaceStore((state) => state.setBranchExecMode);
  const setNewThreadMode = useWorkspaceStore((state) => state.setNewThreadMode);
  const setNewThreadBranch = useWorkspaceStore((state) => state.setNewThreadBranch);
  const setNewThreadBranchFromPr = useWorkspaceStore((state) => state.setNewThreadBranchFromPr);
  const isGitRepo = activeWorkspace?.is_git_repo ?? false;
  const needsWorkspace = isNewThread && !workspaceId;
  const composerMode = isNewThread
    ? (isGitRepo ? newThreadMode : "direct")
    : (activeThread?.mode === "worktree" ? "worktree" : "direct");
  const branchSelectedWorktree = useMemo(() => {
    const normalizedPath = normalizeWorktreePath(branchWorktreePath);
    return worktrees.find((worktree) => normalizeWorktreePath(worktree.path) === normalizedPath) ?? null;
  }, [branchWorktreePath, worktrees]);
  const branchWorktreeIsDetached = isDetachedWorktree(branchSelectedWorktree);
  const { newThreadBranch, forkBranch } = useFlowBranches({ activeThread, branchFromMessageId, isNewThread, workspaceId });
  const isStaleWorktree = useMemo(() => {
    if (!activeThread?.worktree_path || activeThread.mode !== "worktree") return false;
    if (worktreesLoadedForWorkspace !== activeThread.workspace_id) return false;
    const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    return !worktrees.some((worktree) => normalizePath(worktree.path) === normalizePath(activeThread.worktree_path!));
  }, [activeThread, worktrees, worktreesLoadedForWorkspace]);
  const modeOptions = useMemo<ModeOption[]>(
    () => isGitRepo ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((option) => option.value === "direct"),
    [isGitRepo],
  );

  const setMode = useCallback(
    (mode: ComposerMode) => {
      setNewThreadMode(mode);
      rememberComposerMode(mode);
      if (mode === "existing-worktree" && workspaceId) {
        loadWorktrees(workspaceId);
      }
    },
    [loadWorktrees, setNewThreadMode, workspaceId],
  );

  useEffect(() => {
    if (!branchFromMessageId || !workspaceId) return;
    initBranchMode(activeThread);
    loadWorktrees(workspaceId);
  }, [activeThread, branchFromMessageId, initBranchMode, loadWorktrees, workspaceId]);

  const target = useMemo<ComposerExecutionTarget>(() => {
    if (isNewThread) {
      return {
        kind: "new-thread",
        mode: composerMode,
        branch: newThreadBranch.name,
        branchSource: newThreadBranchSource,
        pullRequestNumber: newThreadPullRequestNumber,
        hasWorktree: selectedWorktree !== null,
      };
    }
    if (branchFromMessageId) {
      return {
        kind: "branch",
        mode: branchExecMode,
        branch: forkBranch.name,
        worktreePath: branchWorktreePath,
        worktreeIsDetached: branchWorktreeIsDetached,
      };
    }
    return { kind: "existing-thread", mode: composerMode };
  }, [branchExecMode, branchFromMessageId, forkBranch.name, branchWorktreeIsDetached, branchWorktreePath, composerMode, isNewThread, newThreadBranch.name, newThreadBranchSource, newThreadPullRequestNumber, selectedWorktree]);
  const targetPending = isTargetBranchPending({
    isGitRepo,
    target,
    newThreadWorktreeIsDetached: isDetachedWorktree(selectedWorktree),
    forkWorktreeIsDetached: branchWorktreeIsDetached,
  });

  return {
    target,
    mode: composerMode,
    modeOptions,
    isGitRepo,
    needsWorkspace,
    isStaleWorktree,
    workspacePath: activeWorkspace?.path,
    selectedWorktree,
    newThreadBranch: newThreadBranch.name,
    newThreadBranchSource,
    branchExecMode,
    branchTargetBranch: forkBranch.name,
    branchWorktreePath,
    branchWorktreeIsDetached,
    targetPending,
    setMode,
    setBranchMode: setBranchExecMode,
    setNewThreadMode,
    setNewThreadBranch,
    setNewThreadBranchFromPullRequest: setNewThreadBranchFromPr,
  };
}

/** Reads the branch of the flow on screen only, so the other flow fetches no default. */
function useFlowBranches(options: UseComposerExecutionTargetOptions): { newThreadBranch: TargetBranch; forkBranch: TargetBranch } {
  const newThreadBranch = useNewThreadTargetBranch(options.isNewThread ? options.workspaceId : undefined);
  const forkBranch = useForkTargetBranch(options.branchFromMessageId ? options.activeThread : undefined);
  return { newThreadBranch, forkBranch };
}

interface TargetBranchPendingInput {
  readonly isGitRepo: boolean;
  readonly target: ComposerExecutionTarget;
  readonly newThreadWorktreeIsDetached: boolean;
  readonly forkWorktreeIsDetached: boolean;
}

/** A new thread or fork in a git project needs a branch unless it attaches to a worktree that has one checked out. */
function isTargetBranchPending(input: TargetBranchPendingInput): boolean {
  const { isGitRepo, target } = input;
  if (!isGitRepo || target.kind === "existing-thread" || target.branch !== "") return false;
  if (target.mode !== "existing-worktree") return true;
  return target.kind === "new-thread" ? input.newThreadWorktreeIsDetached : input.forkWorktreeIsDetached;
}
