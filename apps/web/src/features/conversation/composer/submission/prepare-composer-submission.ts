import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { useToastStore } from "@/stores/toastStore";
import type { ComposerFormController } from "../draft/useComposerFormController";
import { readVisibleBrowserNotePages } from "../draft/draft-browser-notes";
import { readVisibleDiffComments } from "../draft/draft-diff-comments";
import { readVisibleFileComments } from "../draft/draft-file-comments";
import { flushPageSnapshots } from "@/features/preview/notes/previewNoteSnapshots";
import { readPlanCommentIdsForSend } from "../draft/sendable-plan-comments";
import { buildComposerAnnotationBundle } from "./composer-annotations";
import { createComposerSubmission } from "./composer-submission";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** Inputs required to snapshot and validate a Composer submit. */
export interface PrepareComposerSubmissionOptions {
  annotationScopeId?: string;
  form: ComposerFormController;
  startingThread: boolean;
  /** Thread whose plan comments this Send may carry; unset when the Send cannot carry them. */
  planCommentThreadId?: string;
  discardEmptyEdit(): boolean;
  resolvePreviewAnnotations(
    annotations: PreviewAnnotationBundle | undefined,
  ): PreviewAnnotationBundle | undefined;
}

/** Reads, validates, and normalizes the current Composer form for transport. */
export async function prepareComposerSubmission({
  annotationScopeId,
  form,
  startingThread,
  planCommentThreadId,
  discardEmptyEdit,
  resolvePreviewAnnotations,
}: PrepareComposerSubmissionOptions): Promise<PreparedComposerSubmission | null> {
  if (!(await isReadyToSubmit(form, annotationScopeId))) return null;

  const snapshot = form.readSubmission();
  const currentDiffComments = annotationScopeId ? readVisibleDiffComments(annotationScopeId) : [];
  const currentFileComments = annotationScopeId ? readVisibleFileComments(annotationScopeId) : [];
  const currentBrowserNotePages = annotationScopeId ? readVisibleBrowserNotePages(annotationScopeId) : [];
  const currentAnnotations = buildComposerAnnotationBundle(
    annotationScopeId,
    currentDiffComments,
    currentFileComments,
    currentBrowserNotePages,
  );
  const previewAnnotations = resolvePreviewAnnotations(currentAnnotations);
  const planCommentIds = planCommentThreadId ? readPlanCommentIdsForSend(planCommentThreadId) : [];
  if (isEmptySubmission(
    snapshot.rawInput,
    snapshot.attachments.length,
    snapshot.selectedTextComments.length + planCommentIds.length,
    previewAnnotations,
  )) {
    discardEmptyEdit();
    return null;
  }
  if (startingThread) return null;

  try {
    const prepared = createComposerSubmission({
      rawInput: snapshot.rawInput,
      attachments: snapshot.attachments,
      previewAnnotations,
    });
    return {
      snapshot,
      prepared,
      trimmed: snapshot.rawInput.trim(),
      goalObjective: snapshot.goalPending ? snapshot.rawInput.trim() : undefined,
      attachmentMetas: form.snapshotAttachmentMetas(),
      currentAnnotations,
      currentDiffComments,
      currentFileComments,
      currentBrowserNotePages,
      previewAnnotations,
      planCommentIds,
    };
  } catch (error) {
    showPreparationFailure(error);
    return null;
  }
}

async function isReadyToSubmit(form: ComposerFormController, annotationScopeId?: string): Promise<boolean> {
  if (await form.attachmentBindings.awaitPreparation()) return false;
  const editorDismissalAnnouncement = form.requestSelectedTextCommentEditorDismissal();
  if (editorDismissalAnnouncement) {
    useToastStore.getState().show({ kind: "failed", title: editorDismissalAnnouncement });
    return false;
  }
  return !annotationScopeId || await settlePageSnapshots(annotationScopeId);
}

/** Determines whether a form snapshot has no message-bearing content. */
function isEmptySubmission(
  rawInput: string,
  attachmentCount: number,
  attachedCommentCount: number,
  previewAnnotations: PreviewAnnotationBundle | undefined,
): boolean {
  return rawInput.trim().length === 0
    && attachmentCount === 0
    && attachedCommentCount === 0
    && !previewAnnotations;
}

/** Displays a payload-normalization failure without mutating the current draft. */
function showPreparationFailure(error: unknown, title = "Could not send message"): void {
  useToastStore.getState().show({
    kind: "failed",
    title,
    meta: error instanceof Error ? error.message : "Invalid page preview payload",
  });
}

/** Redraws any stale page snapshot of a scope. Returns false, after a toast titled `failureTitle`, when one cannot be. */
export async function settlePageSnapshots(scopeId: string, failureTitle?: string): Promise<boolean> {
  try {
    await flushPageSnapshots(scopeId);
    return true;
  } catch (error) {
    showPreparationFailure(error, failureTitle);
    return false;
  }
}
