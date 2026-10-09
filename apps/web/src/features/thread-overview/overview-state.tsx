import { CreatePrDialog } from "@/components/chat/CreatePrDialog";
import { useProjectSetupAttempt } from "@/features/projects/environment";
import { usePullRequestReviewLink } from "@/features/pull-requests";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { type Thread } from "@/transport";
import type { ChecksStatus } from "@mcode/contracts";
import { createContext, useCallback, useContext, useMemo } from "react";
import {
  canStartBranchlessCreatePr,
  CreateThreadBranchDialog,
  useThreadOverviewBranchCreation,
} from "@/features/thread-overview/branch-creation";
import type { ThreadOverviewPr } from "@/features/thread-overview/entries/pull-request";

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

/** Keeps shared Git, setup and dialog state alive while the card is hidden. */
export function useOverviewState(
  thread: Thread,
  open: boolean,
  closeOverlay: () => void,
) {
  const projectSetup = useProjectSetupAttempt(thread.id);
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
    handleCommitOrPush,
    handleOpenPr,
  } = useThreadGitActions(thread);
  const reviewLink = usePullRequestReviewLink(thread.id, open);
  const effectivePr = useMemo(() => getEffectiveThreadOverviewPr(pr, reviewLink), [pr, reviewLink]);
  const branchlessCreatePr = canStartBranchlessCreatePr(thread);
  const createPrBranch = branchCreation.branch ?? thread.branch;
  const createBranchBaseBranch = thread.base_branch ?? thread.branch;
  const openProjectSettings = useCallback(() => {
    closeOverlay();
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "environment");
  }, [closeOverlay, thread.id, thread.workspace_id]);
  const ciDot = useMemo(
    () => getThreadOverviewCiDot(effectivePr, checks),
    [checks, effectivePr],
  );
  return {
    open, projectSetup, branchCreation, prable, effectivePr, hasCommitsAhead,
    checks, openPrDetail, dirPath, createPrOpen, setCreatePrOpen,
    handleCommitOrPush, handleOpenPr, branchlessCreatePr, createPrBranch,
    createBranchBaseBranch, openProjectSettings, ciDot,
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
