import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import {
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
  type DiffAnnotationPayload,
  type DraftDiffComment,
  type MessageMention,
} from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { canSaveSelectedTextComment } from "@/features/conversation/messages/selection/comment-editor-model";
import {
  useComposerDraftStore,
  type ComposerDraft,
  type DiffCommentEditorDraft,
} from "@/stores/composerDraftStore";
import {
  keepEditorOfSentComment,
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

/**
 * True when a Review comment fits the payload budget. Mirrors
 * `DiffAnnotationPayloadSchema`, which counts the note plus its serialized
 * mentions, so the editor never saves a comment that would fail at Send.
 */
export function canSaveDiffComment(note: string, mentions: readonly MessageMention[]): boolean {
  return canSaveSelectedTextComment(note, mentions)
    && note.length + JSON.stringify(mentions).length <= MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS;
}

/**
 * Subscribes to a thread's visible Review comments, numbered after its
 * Browser annotations. Selects only the comment and submission fields, so
 * typing in the open editor does not re-render the diff.
 */
export function useNumberedDiffComments(threadId: string | undefined): readonly DraftDiffComment[] {
  const comments = useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.diffComments : undefined));
  const submissions = useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.submissions : undefined));
  const previewCount = usePreviewAnnotationStore((state) => (threadId ? state.byThread[threadId]?.length ?? 0 : 0));
  return useMemo(() => {
    if (!comments?.length) return EMPTY_COMMENTS;
    return numberDiffComments(visibleDiffComments({ diffComments: comments, submissions }), previewCount);
  }, [comments, previewCount, submissions]);
}

/** Where the open Review comment editor sits, without its text. */
export type DiffCommentEditorAnchor =
  | ({ readonly kind: "draft" } & DiffCommentTarget)
  | { readonly kind: "edit"; readonly annotationId: string };

/** Subscribes to the open editor's anchor, which keystrokes leave unchanged. */
export function useDiffCommentEditorAnchor(threadId: string | undefined): DiffCommentEditorAnchor | undefined {
  const [annotationId, filePath, side, line, lineContent] = useComposerDraftStore(useShallow((state) => {
    const editor = threadId ? state.drafts[threadId]?.diffCommentEditor : undefined;
    return [editor?.annotationId, editor?.target.filePath, editor?.target.side, editor?.target.line, editor?.target.lineContent] as const;
  }));
  return useMemo(() => {
    if (annotationId) return { kind: "edit", annotationId };
    if (filePath === undefined || side === undefined || line === undefined || lineContent === undefined) return undefined;
    return { kind: "draft", filePath, side, line, lineContent };
  }, [annotationId, filePath, line, lineContent, side]);
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
    // Stored as typed: trimming would shift every mention range.
    ...saveDiffComment(draft, target, content, annotationId),
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
 * Removes comments a queued or sent message took with it, unless they were
 * edited since; a later revision is a new comment the message does not own.
 */
export function removeTakenDiffComments(threadId: string, taken: readonly DraftDiffComment[]): void {
  if (taken.length === 0) return;
  const takenRevisions = new Set(taken.map((comment) => `${comment.id}:${comment.revision}`));
  updateThread(threadId, (draft) => {
    const diffComments = (draft.diffComments ?? []).filter(
      (comment) => !takenRevisions.has(`${comment.id}:${comment.revision}`),
    );
    return { ...draft, diffComments, diffCommentEditor: keepEditorOfSentComment(draft.diffCommentEditor, diffComments) };
  });
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
