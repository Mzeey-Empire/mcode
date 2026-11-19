import { useEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { startupHolds, useThreadActivity, type ThreadActivity } from "@/features/thread-attention/thread-activity";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { pickerProviderScopeOf } from "./picker-provider-scope";
import { useNumberedDiffComments } from "./draft/draft-diff-comments";
import { useNumberedFileComments } from "./draft/draft-file-comments";
import { reconcileOrphanedDraftSubmissions } from "./draft/draft-submission-lifecycle";
import { planCommentThreadFor } from "./draft/sendable-plan-comments";
import { usePlanCommentChip } from "./usePlanCommentChip";

interface ComposerSurfaceStateInput {
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly isNewThread: boolean;
  readonly branchFromMessageId?: string;
  readonly activeThread?: {
    readonly clientPreparing?: boolean;
    readonly clientError?: string | null;
    readonly provider?: string | null;
    readonly worktree_path?: string | null;
  };
  readonly composerMode: string;
  readonly provider: string;
  readonly hasDraftContent: boolean;
  readonly isAgentRunning: boolean;
}

function useProviderSurfaceState(provider: ProviderId) {
  const availability = useProviderAvailabilityStore((state) =>
    state.getAvailability(provider),
  );
  const unavailable = Boolean(
    availability && (!availability.enabled || availability.cli.status === "not_found"),
  );

  return {
    providerReason: unavailable
      ? !availability?.enabled
        ? "disabled" as const
        : "cli_missing" as const
      : null,
  };
}

function useCatalogScope(input: ComposerSurfaceStateInput) {
  const catalogThreadId = input.activeThread?.clientPreparing || input.isNewThread
    ? undefined
    : input.threadId;
  const selectedWorktreePath = useWorkspaceStore(
    (state) => state.selectedWorktree?.path,
  );
  const catalogCwd = input.activeThread?.clientPreparing
    ? undefined
    : input.isNewThread && input.composerMode === "existing-worktree"
      ? selectedWorktreePath
      : input.activeThread?.worktree_path ?? undefined;

  return { catalogThreadId, catalogCwd };
}

function getComposerLocks(
  input: ComposerSurfaceStateInput,
  activity: ThreadActivity,
) {
  return {
    // A failed create has no startup to hold it, but the composer still waits on Retry or Dismiss.
    startingThread: startupHolds(activity) || Boolean(input.activeThread?.clientError),
    providerScope: pickerProviderScopeOf({
      started: Boolean(input.threadId && !input.isNewThread && !input.branchFromMessageId),
      threadProviderId: input.activeThread?.provider,
      isAgentRunning: input.isAgentRunning,
    }),
  };
}

/** Derives display-only composer state from the active session and renderer stores. */
export function useComposerSurfaceState(input: ComposerSurfaceStateInput) {
  const annotationScopeId = input.threadId ?? input.workspaceId;
  const annotationRows = usePreviewAnnotationStore((state) =>
    annotationScopeId ? state.byThread[annotationScopeId] : undefined,
  );
  const diffComments = useNumberedDiffComments(annotationScopeId);
  const fileComments = useNumberedFileComments(annotationScopeId);
  const codeComments = useMemo(
    () => (fileComments.length === 0 ? diffComments : [...diffComments, ...fileComments]),
    [diffComments, fileComments],
  );
  const previewAnnotationCount = annotationRows?.length ?? 0;
  const connected = useConnectionStore((state) => state.status === "connected");
  // Reruns on reconnect, so a submission a dropped connection left pending settles.
  useEffect(() => {
    if (input.threadId && connected) void reconcileOrphanedDraftSubmissions(input.threadId);
  }, [connected, input.threadId]);
  const ridingPlanComments = usePlanCommentChip(planCommentThreadFor(input));
  const annotationCount = previewAnnotationCount + codeComments.length + ridingPlanComments.length;
  const effectiveProviderId = input.provider as ProviderId;
  const providerSurfaceState = useProviderSurfaceState(effectiveProviderId);
  const catalogScope = useCatalogScope(input);
  // Startup state lives outside the thread row so list refreshes cannot drop
  // the composer lock between thread creation and the agent's first event.
  const activity = useThreadActivity(input.threadId ?? "", {
    preparing: input.activeThread?.clientPreparing === true,
    createFailed: input.activeThread?.clientError != null,
  });
  const composerLocks = getComposerLocks(input, activity);

  return {
    annotationScopeId,
    codeCommentsForDisplay: codeComments,
    ...catalogScope,
    ...composerLocks,
    effectiveProviderId,
    hasContent: input.hasDraftContent || annotationCount > 0,
    ...providerSurfaceState,
  };
}
