import { useMemo } from "react";
import type { DiffAnnotationPayload, DraftDiffComment } from "@mcode/contracts";
import {
  useComposerDraftStore,
  type ComposerDraft,
  type DiffCommentEditorDraft,
} from "@/stores/composerDraftStore";
import {
  removeDiffComment,
  saveDiffComment,
  visibleDiffComments,
  type DiffCommentContent,
  type DiffCommentTarget,
} from "./draft-submission";

const EMPTY_COMMENTS: readonly DraftDiffComment[] = [];

/**
 * Numbers Review comments after the thread's Browser annotations, so the
 * numbers shown on Browser pins and in the sent bundle agree.
 */
export function numberDiffComments(
  comments: readonly DraftDiffComment[],
  previewAnnotationCount: number,
): DraftDiffComment[] {
  return comments.map((comment, index) => ({ ...comment, displayNumber: previewAnnotationCount + index + 1 }));
}

/** Review comments a thread's next Send would carry, hiding revisions a pending Send holds. */
export function readVisibleDiffComments(threadId: string): DraftDiffComment[] {
  const draft = useComposerDraftStore.getState().drafts[threadId];
  return draft ? visibleDiffComments(draft) : [];
}

/** Subscribes to the visible Review comments of one thread. */
export function useVisibleDiffComments(threadId: string | undefined): readonly DraftDiffComment[] {
  const draft = useComposerDraftStore((state) => (threadId ? state.drafts[threadId] : undefined));
  return useMemo(() => (draft ? visibleDiffComments(draft) : EMPTY_COMMENTS), [draft]);
}

/** Subscribes to the open Review comment editor of one thread. */
export function useDiffCommentEditor(threadId: string | undefined): DiffCommentEditorDraft | undefined {
  return useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.diffCommentEditor : undefined));
}

function updateThread(threadId: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  useComposerDraftStore.getState().updateNextMessage(threadId, update);
}

/** Saves a Review comment and closes its editor. */
export function saveDraftDiffComment(
  threadId: string,
  target: DiffCommentTarget,
  content: DiffCommentContent,
  annotationId?: string,
): void {
  updateThread(threadId, (draft) => ({
    ...saveDiffComment(draft, target, { note: content.note.trim(), mentions: content.mentions }, annotationId),
    diffCommentEditor: undefined,
  }));
}

/** Drops the draft's reference to one Review comment. */
export function deleteDraftDiffComment(threadId: string, annotationId: string): void {
  updateThread(threadId, (draft) => {
    const editor = draft.diffCommentEditor;
    return {
      ...removeDiffComment(draft, annotationId),
      diffCommentEditor: editor?.annotationId === annotationId ? undefined : editor,
    };
  });
}

/** Drops every visible Review comment of a thread. Comments a pending Send holds stay with it. */
export function clearVisibleDiffComments(threadId: string): void {
  updateThread(threadId, (draft) => {
    const visible = new Set(visibleDiffComments(draft).map((comment) => comment.id));
    if (visible.size === 0) return draft;
    return { ...draft, diffComments: (draft.diffComments ?? []).filter((comment) => !visible.has(comment.id)) };
  });
}

/** Opens, updates or closes the thread's Review comment editor. */
export function setDraftDiffCommentEditor(threadId: string, editor: DiffCommentEditorDraft | undefined): void {
  updateThread(threadId, (draft) => (draft.diffCommentEditor === editor ? draft : { ...draft, diffCommentEditor: editor }));
}

/** Opens the editor on a saved comment with its current text. */
export function editDraftDiffComment(threadId: string, comment: DraftDiffComment): void {
  setDraftDiffCommentEditor(threadId, {
    target: { filePath: comment.filePath, side: comment.side, line: comment.line, lineContent: comment.lineContent },
    annotationId: comment.id,
    note: comment.note,
    mentions: [...(comment.mentions ?? [])],
  });
}

/**
 * Removes comments a queued message took with it, unless they were edited
 * since; a later revision is a new comment the queue does not own.
 */
export function removeQueuedDiffComments(threadId: string, taken: readonly DraftDiffComment[]): void {
  if (taken.length === 0) return;
  const takenRevisions = new Set(taken.map((comment) => `${comment.id}:${comment.revision}`));
  updateThread(threadId, (draft) => ({
    ...draft,
    diffComments: (draft.diffComments ?? []).filter(
      (comment) => !takenRevisions.has(`${comment.id}:${comment.revision}`),
    ),
  }));
}

/** Puts comments from a queued message back into the draft as new revisions. */
export function restoreQueuedDiffComments(threadId: string, comments: readonly DiffAnnotationPayload[]): void {
  if (comments.length === 0) return;
  updateThread(threadId, (draft) => comments.reduce<ComposerDraft>((next, comment) => {
    const existing = next.diffComments?.some((candidate) => candidate.id === comment.id);
    const { filePath, side, line, lineContent } = comment;
    const restored = saveDiffComment(
      next,
      { filePath, side, line, lineContent },
      { note: comment.note, mentions: comment.mentions ?? [] },
      existing ? comment.id : undefined,
    );
    if (existing) return restored;
    // Keep the queued comment's id so a later edit in the queue still targets it.
    const added = restored.diffComments!.at(-1)!;
    return { ...restored, diffComments: [...restored.diffComments!.slice(0, -1), { ...added, id: comment.id }] };
  }, draft));
}
