import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { materializeStagedSnapshots } from "@/features/preview/notes/stagedDraftImages";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { browserNoteElements, removeTakenBrowserNotePages } from "../draft/draft-browser-notes";
import { removeTakenDiffComments } from "../draft/draft-diff-comments";
import { removeTakenFileComments } from "../draft/draft-file-comments";
import type { PreparedComposerSubmission } from "./composer-submission-types";

/** Design-mode lifecycle around a single immediate Composer dispatch. */
export interface ComposerAnnotationDispatchGuard {
  leaveDesignMode(): void;
  returnToDesignModeAfterFailure(): void;
}

/**
 * Turns Design mode off while a Send that carries annotations is in flight and back on if it
 * fails. The notes themselves stay in the draft: a pending Send holds them and a failed one
 * releases them, so nothing here copies or restores them.
 */
export function createComposerAnnotationDispatchGuard(
  annotationScopeId: string | undefined,
  annotations: PreviewAnnotationBundle | undefined,
): ComposerAnnotationDispatchGuard {
  if (!annotationScopeId || !annotations) return EMPTY_ANNOTATION_DISPATCH_GUARD;
  return {
    leaveDesignMode: () => usePreviewDesignModeStore.getState().setActive(annotationScopeId, false),
    returnToDesignModeAfterFailure: () => usePreviewDesignModeStore.getState().setActive(annotationScopeId, true),
  };
}

const EMPTY_ANNOTATION_DISPATCH_GUARD: ComposerAnnotationDispatchGuard = {
  leaveDesignMode: () => {},
  returnToDesignModeAfterFailure: () => {},
};

/**
 * Staged snapshots live under the annotation scope, so a Send that creates a
 * thread carries their bytes as attachments instead. A Send to this thread
 * leaves them staged for the server to resolve.
 */
export async function materializeSubmissionSnapshots(
  annotationScopeId: string | undefined,
  sendsToThisThread: boolean,
  submission: PreparedComposerSubmission,
): Promise<PreparedComposerSubmission> {
  if (sendsToThisThread || !annotationScopeId) return submission;
  return {
    ...submission,
    previewAnnotations: await materializeStagedSnapshots(annotationScopeId, submission.previewAnnotations),
  };
}

/**
 * Removes the notes and comments a delivered Send that created a thread took.
 * A Send to this thread settles them through its draft submission instead.
 */
export function removeTakenSubmissionAnnotations(
  annotationScopeId: string | undefined,
  sendsToThisThread: boolean,
  submission: PreparedComposerSubmission,
): void {
  if (sendsToThisThread || !annotationScopeId) return;
  removeTakenDiffComments(annotationScopeId, submission.currentDiffComments);
  removeTakenFileComments(annotationScopeId, submission.currentFileComments);
  removeTakenBrowserNotePages(annotationScopeId, browserNoteElements(submission.currentBrowserNotePages));
}
