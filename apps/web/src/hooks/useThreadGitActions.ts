import { useCallback, useState, type MouseEvent } from "react";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { isPrable } from "@/lib/is-prable";
import { resolveThreadDirPath } from "@/lib/worktree";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import type { Thread } from "@/transport";
import { rankPullRequests } from "@mcode/contracts/models/thread-pull-request";

function resolveStoredPr(
  thread: Thread,
  cachedPrUrl: string | undefined,
): { number: number; url: string; state: string } | null {
  const primary = rankPullRequests(thread.pull_requests)[0];
  const url = primary?.url ?? cachedPrUrl;
  if (!primary || !url) return null;
  return {
    number: primary.number,
    url,
    state: primary.state,
  };
}

function resolveCurrentPr<T extends { number: number; url: string; state: string }>(
  polledPr: T | null | undefined,
  storePr: { number: number; url: string; state: string } | null,
): T | { number: number; url: string; state: string } | null {
  if (storePr && polledPr?.url && polledPr.number !== storePr.number) return storePr;
  if (storePr && polledPr?.url) return { ...polledPr, ...storePr };
  return polledPr?.url ? polledPr : storePr;
}

function useThreadPrState(thread: Thread) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === thread.workspace_id),
  );
  const prable = isPrable(thread);
  const cwd = workspace?.path ?? null;
  const polledPr = useBranchPr(
    prable ? thread.branch : null,
    cwd,
  );
  const cachedPrUrl = useWorkspaceStore((state) => state.prUrlsByThreadId[thread.id]);
  const checks = useWorkspaceStore((state) => state.checksById[thread.id]) ?? null;
  const storePr = resolveStoredPr(thread, cachedPrUrl);
  const pr = resolveCurrentPr(polledPr, storePr);
  // Only a polled PR carries a title; one this client just created shows none until the next poll.
  const openPrDetail = pr && "title" in pr ? { title: pr.title } : null;
  return {
    workspace,
    prable,
    pr,
    checks,
    openPrDetail,
  };
}

/** Provide shared commit and PR actions, PR state, and creation-dialog state for a thread. */
export function useThreadGitActions(thread: Thread) {
  const [createPrOpen, setCreatePrOpen] = useState(false);
  const { workspace, prable, pr, checks, openPrDetail } = useThreadPrState(thread);
  const dirPath = resolveThreadDirPath(thread, workspace?.path ?? null);

  // Whether the branch has commits ahead of base (disable Create PR when it doesn't).
  const hasCommitsAhead = useHasCommitsAhead(
    prable ? thread.workspace_id : "",
    prable ? thread.branch : null,
    prable ? thread.id : undefined,
  );

  const { id: threadId, workspace_id: workspaceId } = thread;
  const handleCommit = useCallback(() => {
    const diff = useDiffStore.getState();
    showRightPanelAdaptive(workspaceId, threadId);
    diff.setRightPanelTab(workspaceId, threadId, "changes");
    diff.setCommitSheetScopeId(threadId);
  }, [workspaceId, threadId]);

  const handleOpenPr = useCallback(
    (url: string, event?: MouseEvent) => {
      openGitHubUrl(url, thread.id, event);
    },
    [thread.id],
  );

  return {
    prable,
    pr,
    hasCommitsAhead,
    checks,
    openPrDetail,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommit,
    handleOpenPr,
  };
}
