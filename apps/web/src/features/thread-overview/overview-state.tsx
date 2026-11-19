import { CreatePrDialog } from "@/components/chat/CreatePrDialog";
import { usePullRequestReviewLink } from "@/features/pull-requests";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport, type Thread } from "@/transport";
import type { ChecksStatus } from "@mcode/contracts/github";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  CreateThreadBranchDialog,
  useThreadOverviewBranchCreation,
} from "@/features/thread-overview/branch-creation";
import type { ThreadOverviewPr } from "@/features/thread-overview/entries/pull-request";
import { planGitRow } from "@/features/thread-overview/git-next-step";
import { useReviewState } from "@/hooks/useReviewState";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";

/** CI dot shown on the Overview trigger for terminal check states. */
export type ThreadOverviewCiDot = "red" | "green" | null;

/** Derives the pull request identity used by the Overview. */
function getEffectiveThreadOverviewPr(
  pr: ThreadOverviewPr,
  reviewLink: ReturnType<typeof usePullRequestReviewLink>,
): ThreadOverviewPr {
  if (pr) return pr;
  if (!reviewLink) return null;
  return {
    number: reviewLink.identity.number,
    url: reviewLink.pullRequestUrl,
    state: reviewLink.pullRequestState,
  };
}

/**
 * Derives the active thread's compact CI signal for the Overview trigger.
 */
export function getThreadOverviewCiDot(
  pr: { state: string } | null,
  checks: ChecksStatus | null,
): ThreadOverviewCiDot {
  if (!pr || pr.state.toLowerCase() !== "open" || !checks) return null;
  if (checks.aggregate === "failing") return "red";
  if (checks.aggregate === "passing") return "green";
  return null;
}

function hasUncommittedChanges(state: ReviewState | null): boolean | null {
  if (!state?.isGitRepo) return null;
  const { staged, unstaged, untracked } = state.uncommitted;
  return staged + unstaged + untracked > 0;
}

/**
 * Whether the branch has commits its upstream lacks, or null while Review has not answered.
 * A branch with no upstream counts its commits ahead of base as unpushed.
 */
function hasUnpushedCommits(state: ReviewState | null): boolean | null {
  if (!state?.isGitRepo) return null;
  if (state.upstream) return state.upstream.ahead > 0;
  return (state.commitsAhead?.count ?? 0) > 0;
}

/** Progress of the git row's Push. */
export type GitPushState = { kind: "idle" } | { kind: "pushing" } | { kind: "failed"; message: string };

const IDLE_PUSH: GitPushState = { kind: "idle" };

/**
 * Pushes the thread's branch from the git row. Lives with the Overview state rather than the
 * row so a push started before the card closes still reports when it reopens.
 */
function useGitPush(thread: Thread) {
  const [push, setPush] = useState<{ threadId: string; state: GitPushState }>({ threadId: thread.id, state: IDLE_PUSH });
  const [refresh, setRefresh] = useState(0);
  // A push that lands after the user switched threads must not report on the new thread.
  const threadIdRef = useRef(thread.id);
  threadIdRef.current = thread.id;
  const gitPush = push.threadId === thread.id ? push.state : IDLE_PUSH;
  const pushBranch = useCallback(async () => {
    if (gitPush.kind === "pushing") return;
    const threadId = thread.id;
    setPush({ threadId, state: { kind: "pushing" } });
    try {
      await getTransport().push(thread.workspace_id, thread.branch, threadId);
      if (threadIdRef.current !== threadId) return;
      setPush({ threadId, state: IDLE_PUSH });
      setRefresh((count) => count + 1);
    } catch (err) {
      if (threadIdRef.current !== threadId) return;
      setPush({ threadId, state: { kind: "failed", message: err instanceof Error ? err.message : String(err) } });
    }
  }, [gitPush.kind, thread.branch, thread.id, thread.workspace_id]);
  return { gitPush, pushBranch, refresh };
}

/** Keeps shared Git and dialog state alive while the card is hidden. */
export function useOverviewState(
  thread: Thread,
  open: boolean,
  closeOverlay: () => void,
) {
  const branchCreation = useThreadOverviewBranchCreation(thread.id);
  const {
    prable,
    pr,
    hasCommitsAhead,
    checks,
    openPrDetail,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommit: openCommitSheet,
    handleOpenPr,
  } = useThreadGitActions(thread);
  const reviewLink = usePullRequestReviewLink(thread.id, open);
  const effectivePr = useMemo(() => getEffectiveThreadOverviewPr(pr, reviewLink), [pr, reviewLink]);
  // Only a named-branch worktree's git row reads uncommitted changes, and each probe spawns several git processes.
  const { gitPush, pushBranch, refresh } = useGitPush(thread);
  // A landed push bumps refresh so Review re-probes and the row moves to the next step.
  const { state: reviewState } = useReviewState(prable ? thread.workspace_id : null, thread.id, refresh);
  const gitRow = useMemo(() => planGitRow({
    mode: thread.mode,
    checkoutState: thread.checkout_state,
    hasPullRequest: effectivePr !== null,
    hasUncommittedChanges: hasUncommittedChanges(reviewState),
    hasCommitsAhead,
    hasUnpushedCommits: hasUnpushedCommits(reviewState),
  }), [effectivePr, hasCommitsAhead, reviewState, thread.checkout_state, thread.mode]);
  const createPrBranch = branchCreation.branch ?? thread.branch;
  const createBranchBaseBranch = thread.base_branch ?? thread.branch;
  const openProjectSettings = useCallback(() => {
    closeOverlay();
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "environment");
  }, [closeOverlay, thread.id, thread.workspace_id]);
  const handleCommit = useCallback((options?: { push?: boolean }) => {
    closeOverlay();
    openCommitSheet(options);
  }, [closeOverlay, openCommitSheet]);
  const ciDot = useMemo(
    () => getThreadOverviewCiDot(effectivePr, checks),
    [checks, effectivePr],
  );
  return {
    open, branchCreation, prable, effectivePr, hasCommitsAhead,
    checks, openPrDetail, dirPath, createPrOpen, setCreatePrOpen,
    handleCommit, handleOpenPr, gitRow, createPrBranch,
    createBranchBaseBranch, openProjectSettings, ciDot, gitPush, pushBranch,
  };
}

/** Thread overview state shared by entries without duplicating Git polling. */
export const OverviewContext = createContext<ReturnType<typeof useOverviewState> | null>(null);

/** Reads the active overview's shared state. */
export function useOverviewContext() {
  const state = useContext(OverviewContext);
  if (!state) throw new Error("Overview entries require OverviewContext");
  return state;
}

/** Dialogs outlive their menu rows when the overview closes. */
export function OverviewDialogs({ thread }: { thread: Thread }) {
  const { branchCreation, createBranchBaseBranch, prable, createPrOpen, setCreatePrOpen, createPrBranch } = useOverviewContext();
  return (<>
    <CreateThreadBranchDialog
      open={branchCreation.open}
      onOpenChange={branchCreation.setOpen}
      thread={thread}
      title="Work here"
      description="Create a branch to commit changes, push, and create a PR from this worktree."
      submitLabel="Create"
      onCreated={(branch) => {
        branchCreation.complete(branch, createBranchBaseBranch);
      }}
    />

    {(prable || branchCreation.branch) && (
      <CreatePrDialog
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        threadId={thread.id}
        workspaceId={thread.workspace_id}
        branch={createPrBranch}
        preferredBaseBranch={branchCreation.baseBranch ?? thread.base_branch}
      />
    )}
  </>);
}
