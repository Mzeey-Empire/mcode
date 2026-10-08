import { useEffect } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import type { ProviderId } from "@mcode/contracts";
import { useNumberedDiffComments } from "./draft/draft-diff-comments";
import { reconcileOrphanedDraftSubmissions } from "./draft/draft-submission-lifecycle";

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
  startupPending: boolean,
) {
  return {
    isThreadScaffold: Boolean(
      input.activeThread?.clientPreparing || input.activeThread?.clientError || startupPending,
    ),
    isModelFullyLocked: input.isAgentRunning && !input.branchFromMessageId,
    isProviderLocked: Boolean(
      input.threadId && !input.isNewThread && !input.branchFromMessageId
        && input.activeThread?.provider,
    ),
  };
}

/** Derives display-only composer state from the active session and renderer stores. */
export function useComposerSurfaceState(input: ComposerSurfaceStateInput) {
  const annotationScopeId = input.threadId ?? input.workspaceId;
  const annotationRows = usePreviewAnnotationStore((state) =>
    annotationScopeId ? state.byThread[annotationScopeId] : undefined,
  );
  const diffComments = useNumberedDiffComments(input.threadId);
  const previewAnnotationCount = annotationRows?.length ?? 0;
  const connected = useConnectionStore((state) => state.status === "connected");
  // Reruns on reconnect, so a submission a dropped connection left pending settles.
  useEffect(() => {
    if (input.threadId && connected) void reconcileOrphanedDraftSubmissions(input.threadId);
  }, [connected, input.threadId]);
  const annotationCount = previewAnnotationCount + diffComments.length;
  const annotationBundleForDisplay = annotationScopeId
    ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
    : undefined;
  const effectiveProviderId = input.provider as ProviderId;
  const providerSurfaceState = useProviderSurfaceState(effectiveProviderId);
  const catalogScope = useCatalogScope(input);
  // Startup state lives outside the thread row so list refreshes cannot drop
  // the composer lock between thread creation and the agent's first event.
  const startupPending = useWorkspaceStore((state) =>
    input.threadId ? state.pendingStartupByThreadId[input.threadId] !== undefined : false);
  const composerLocks = getComposerLocks(input, startupPending);

  return {
    annotationScopeId,
    annotationBundleForDisplay,
    diffCommentsForDisplay: diffComments,
    ...catalogScope,
    ...composerLocks,
    effectiveProviderId,
    hasContent: input.hasDraftContent || annotationCount > 0,
    ...providerSurfaceState,
  };
}
