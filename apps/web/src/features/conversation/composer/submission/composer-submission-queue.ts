import type { MessageMention } from "@mcode/contracts/models/mention";
import type { PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import { collectBrowserCaptureSpillPaths, releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import type { ComposerAgentSelection, ComposerFormController } from "../draft/useComposerFormController";
import type { ComposerQueueEdit } from "../queue/useComposerQueueEditing";
import { queueHoldingDraftElements } from "../queue/queued-draft-holds";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** Inputs for persisting a queued existing-thread submit. */
export interface QueueComposerSubmissionOptions {
  threadId?: string;
  editing: ComposerQueueEdit | null;
  submission: PreparedComposerSubmission;
}

/** Inputs for finishing a Composer submit that entered a queue. */
export interface CompleteQueuedComposerSubmissionOptions {
  annotationScopeId?: string;
  annotations?: PreviewAnnotationBundle;
  goalObjective?: string;
  form: ComposerFormController;
  finishEditing(): void;
}

/**
 * Persists a prepared Composer submit in its target thread's queue. The draft holds the
 * comments and notes it carries until the queued message is admitted or leaves the queue.
 */
export function queueComposerSubmission({
  threadId,
  editing,
  submission,
}: QueueComposerSubmissionOptions): boolean {
  if (!threadId) return false;
  const spillPaths = collectBrowserCaptureSpillPaths(submission.prepared.browserCaptures);
  const payload = createPersistentQueuePayload(submission, spillPaths);
  const enqueued = queueHoldingDraftElements(threadId, payload, {
    diffComments: submission.currentDiffComments,
    fileComments: submission.currentFileComments,
    browserNotePages: submission.currentBrowserNotePages,
  }, editing?.originalIndex);
  if (!enqueued) void releaseBrowserCaptureSpills(spillPaths);
  return enqueued;
}

/** Applies the shared UI cleanup after a queued submit is accepted. */
export function completeQueuedComposerSubmission({
  annotationScopeId,
  annotations,
  goalObjective,
  form,
  finishEditing,
}: CompleteQueuedComposerSubmissionOptions): void {
  form.clear("dispatch");
  if (annotationScopeId && annotations) usePreviewDesignModeStore.getState().setActive(annotationScopeId, false);
  if (goalObjective) form.setGoalPending(false);
  finishEditing();
  form.focus();
}

/** Maps a prepared submit onto the persistent queue-store representation. */
function createPersistentQueuePayload(
  submission: PreparedComposerSubmission,
  browserCaptureSpillPaths: string[],
) {
  const { snapshot, prepared } = submission;
  const selection = snapshot.selection;
  return {
    content: stripPreviewAnnotationFence(prepared.content),
    displayContent: prepared.displayContent,
    mentions: optionalMentions(snapshot.mentions),
    previewAnnotations: submission.previewAnnotations,
    attachments: submission.attachmentMetas,
    model: selection.modelId,
    permissionMode: selection.permissionMode,
    approvalReviewMode: selection.approvalReviewMode,
    reasoningLevel: selection.reasoning,
    orchestrationMode: selection.orchestrationMode,
    provider: selection.provider,
    contextWindow: selection.contextWindow ?? undefined,
    thinking: selection.thinking ?? undefined,
    fastMode: optionalFastMode(selection),
    devinMode: selection.provider === "devin" ? selection.devinMode ?? undefined : undefined,
    goalObjective: submission.goalObjective,
    browserCaptureSpillPaths: browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
  };
}

/** Returns mentions only when the queue entry has at least one. */
function optionalMentions(mentions: MessageMention[]): MessageMention[] | undefined {
  return mentions.length > 0 ? mentions : undefined;
}

/** Keeps fast-mode metadata scoped to Codex submissions. */
function optionalFastMode(selection: ComposerAgentSelection): boolean | undefined {
  return selection.provider === "codex" ? selection.fastMode ?? undefined : undefined;
}
