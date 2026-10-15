import type { MessageMention, PreviewAnnotationBundle } from "@mcode/contracts";
import { collectBrowserCaptureSpillPaths, releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { browserNoteElements, removeTakenBrowserNotePages } from "../draft/draft-browser-notes";
import { removeTakenDiffComments } from "../draft/draft-diff-comments";
import { removeTakenFileComments } from "../draft/draft-file-comments";
import type { ComposerAgentSelection, ComposerFormController } from "../draft/useComposerFormController";
import type { ComposerQueueEdit } from "../queue/useComposerQueueEditing";
import type { HandoffQueuedSend } from "../queue/useHandoffQueuedSend";
import { queueHoldingDraftElements } from "../queue/queued-draft-holds";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** Inputs for creating a deferred handoff payload. */
export interface CreateHandoffQueuedSendOptions {
  submission: PreparedComposerSubmission;
}

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

/** Creates the full payload retained while a child-thread handoff is generating. */
export function createHandoffQueuedSend({
  submission,
}: CreateHandoffQueuedSendOptions): HandoffQueuedSend {
  const { snapshot, prepared } = submission;
  const browserCaptureSpillPaths = collectBrowserCaptureSpillPaths(prepared.browserCaptures);
  return {
    content: prepared.content,
    displayContent: prepared.displayContent,
    mentions: snapshot.mentions,
    previewAnnotations: submission.previewAnnotations,
    goalObjective: submission.goalObjective,
    orchestrationMode: snapshot.selection.orchestrationMode,
    attachments: submission.attachmentMetas,
    selection: snapshot.selection,
    browserCaptureSpillPaths: browserCaptureSpillPaths.length > 0 ? browserCaptureSpillPaths : undefined,
  };
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
    codexFastMode: optionalCodexFastMode(selection),
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
function optionalCodexFastMode(selection: ComposerAgentSelection): boolean | undefined {
  return selection.provider === "codex" ? selection.codexFastMode ?? undefined : undefined;
}

/**
 * Removes the comments and notes a handoff-deferred submit took. That submit waits in
 * Composer memory with no queue entry to hold them under, so they leave the draft now.
 */
export function removeHandoffTakenAnnotations(
  annotationScopeId: string | undefined,
  submission: PreparedComposerSubmission,
): void {
  if (!annotationScopeId || !submission.currentAnnotations) return;
  removeTakenBrowserNotePages(annotationScopeId, browserNoteElements(submission.currentBrowserNotePages));
  removeTakenDiffComments(annotationScopeId, submission.currentDiffComments);
  removeTakenFileComments(annotationScopeId, submission.currentFileComments);
}
