import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { useToastStore } from "@/stores/toastStore";
import type { ComposerFormController } from "../draft/useComposerFormController";
import { readVisibleDiffComments } from "../draft/draft-diff-comments";
import { readPlanCommentsForSend } from "../draft/plan-comment-selection";
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

const NO_PLAN_COMMENTS = { ridingIds: [], excludedIds: [] };

/** Reads, validates, and normalizes the current Composer form for transport. */
export async function prepareComposerSubmission({
  annotationScopeId,
  form,
  startingThread,
  planCommentThreadId,
  discardEmptyEdit,
  resolvePreviewAnnotations,
}: PrepareComposerSubmissionOptions): Promise<PreparedComposerSubmission | null> {
  if (await form.attachmentBindings.awaitPreparation()) return null;
  const editorDismissalAnnouncement = form.requestSelectedTextCommentEditorDismissal();
  if (editorDismissalAnnouncement) {
    useToastStore.getState().show({
      kind: "failed",
      title: editorDismissalAnnouncement,
    });
    return null;
  }

  const snapshot = form.readSubmission();
  const currentDiffComments = annotationScopeId ? readVisibleDiffComments(annotationScopeId) : [];
  const currentAnnotations = buildComposerAnnotationBundle(annotationScopeId, currentDiffComments);
  const previewAnnotations = resolvePreviewAnnotations(currentAnnotations);
  const planComments = planCommentThreadId ? readPlanCommentsForSend(planCommentThreadId) : NO_PLAN_COMMENTS;
  if (isEmptySubmission(
    snapshot.rawInput,
    snapshot.attachments.length,
    snapshot.selectedTextComments.length + planComments.ridingIds.length,
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
      previewAnnotations,
      planComments,
    };
  } catch (error) {
    showPreparationFailure(error);
    return null;
  }
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
function showPreparationFailure(error: unknown): void {
  useToastStore.getState().show({
    kind: "failed",
    title: "Could not send message",
    meta: error instanceof Error ? error.message : "Invalid page preview payload",
  });
}
