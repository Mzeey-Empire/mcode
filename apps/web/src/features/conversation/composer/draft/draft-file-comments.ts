import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { DraftFileComment } from "@mcode/contracts/models/next-message-draft";
import type { FileAnnotationPayload } from "@mcode/contracts/models/browser-preview";
import type { MessageMention } from "@mcode/contracts/models/mention";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import {
  useComposerDraftStore,
  type ComposerDraft,
  type FileCommentEditorDraft,
} from "@/stores/composerDraftStore";
import { canSaveDiffComment } from "./draft-diff-comments";
import {
  keepEditorOfSentComment,
  removeFileComment,
  saveFileComment,
  visibleDiffComments,
  visibleFileComments,
  type DiffCommentContent,
  type FileCommentTarget,
} from "./draft-submission";

const EMPTY_COMMENTS: readonly DraftFileComment[] = [];

/**
 * True when a Files comment fits the payload budget. Files and Review comments
 * share the same note and mentions limit.
 */
export function canSaveFileComment(note: string, mentions: readonly MessageMention[]): boolean {
  return canSaveDiffComment(note, mentions);
}

/**
 * Numbers Files comments after the thread's Browser annotations and Review
 * comments, so every number in the composer and the sent bundle is unique.
 */
export function numberFileComments(
  comments: readonly DraftFileComment[],
  precedingCount: number,
): DraftFileComment[] {
  return comments.map((comment, index) => ({ ...comment, displayNumber: precedingCount + index + 1 }));
}

/** Files comments a thread's next Send would carry, hiding revisions a pending Send holds. */
export function readVisibleFileComments(threadId: string): DraftFileComment[] {
  const draft = useComposerDraftStore.getState().drafts[threadId];
  return draft ? visibleFileComments(draft) : [];
}

/**
 * Subscribes to a thread's visible Files comments, numbered after its Browser
 * annotations and Review comments. Selects only comment and submission fields,
 * so typing in an open editor does not re-render the file view.
 */
export function useNumberedFileComments(threadId: string | undefined): readonly DraftFileComment[] {
  const comments = useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.fileComments : undefined));
  const diffComments = useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.diffComments : undefined));
  const submissions = useComposerDraftStore((state) => (threadId ? state.drafts[threadId]?.submissions : undefined));
  const previewCount = usePreviewAnnotationStore((state) => (threadId ? state.byThread[threadId]?.length ?? 0 : 0));
  return useMemo(() => {
    if (!comments?.length) return EMPTY_COMMENTS;
    const draft = { diffComments, fileComments: comments, submissions };
    return numberFileComments(visibleFileComments(draft), previewCount + visibleDiffComments(draft).length);
  }, [comments, diffComments, previewCount, submissions]);
}

/** Where the open Files comment editor sits, without its text. */
export type FileCommentEditorAnchor =
  | ({ readonly kind: "draft" } & FileCommentTarget)
  | { readonly kind: "edit"; readonly annotationId: string };

/** Subscribes to the open Files editor's anchor, which keystrokes leave unchanged. */
export function useFileCommentEditorAnchor(threadId: string | undefined): FileCommentEditorAnchor | undefined {
  const [annotationId, filePath, line, lineContent] = useComposerDraftStore(useShallow((state) => {
    const editor = threadId ? state.drafts[threadId]?.fileCommentEditor : undefined;
    return [editor?.annotationId, editor?.target.filePath, editor?.target.line, editor?.target.lineContent] as const;
  }));
  return useMemo(() => {
    if (annotationId) return { kind: "edit", annotationId };
    if (filePath === undefined || line === undefined || lineContent === undefined) return undefined;
    return { kind: "draft", filePath, line, lineContent };
  }, [annotationId, filePath, line, lineContent]);
}

function updateThread(threadId: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  useComposerDraftStore.getState().updateNextMessage(threadId, update);
}

/** Saves a Files comment and closes its editor. */
export function saveDraftFileComment(
  threadId: string,
  target: FileCommentTarget,
  content: DiffCommentContent,
  annotationId?: string,
): void {
  updateThread(threadId, (draft) => ({
    // Stored as typed: trimming would shift every mention range.
    ...saveFileComment(draft, target, content, annotationId),
    fileCommentEditor: undefined,
  }));
}

/** Drops the draft's reference to one Files comment. */
export function deleteDraftFileComment(threadId: string, annotationId: string): void {
  updateThread(threadId, (draft) => {
    const editor = draft.fileCommentEditor;
    return {
      ...removeFileComment(draft, annotationId),
      fileCommentEditor: editor?.annotationId === annotationId ? undefined : editor,
    };
  });
}

/** Drops every visible Files comment of a thread. Comments a pending Send holds stay with it. */
export function clearVisibleFileComments(threadId: string): void {
  updateThread(threadId, (draft) => {
    const visible = new Set(visibleFileComments(draft).map((comment) => comment.id));
    if (visible.size === 0) return draft;
    return { ...draft, fileComments: (draft.fileComments ?? []).filter((comment) => !visible.has(comment.id)) };
  });
}

/** Opens, updates or closes the thread's Files comment editor. */
export function setDraftFileCommentEditor(threadId: string, editor: FileCommentEditorDraft | undefined): void {
  updateThread(threadId, (draft) => (draft.fileCommentEditor === editor ? draft : { ...draft, fileCommentEditor: editor }));
}

/** Opens the Files editor on a saved comment with its current text. */
export function editDraftFileComment(threadId: string, comment: DraftFileComment): void {
  setDraftFileCommentEditor(threadId, {
    target: { filePath: comment.filePath, line: comment.line, lineContent: comment.lineContent },
    annotationId: comment.id,
    note: comment.note,
    mentions: [...(comment.mentions ?? [])],
  });
}

/**
 * Removes Files comments a queued or sent message took with it, unless they
 * were edited since; a later revision is a new comment the message does not own.
 */
export function removeTakenFileComments(threadId: string, taken: readonly DraftFileComment[]): void {
  if (taken.length === 0) return;
  const takenRevisions = new Set(taken.map((comment) => `${comment.id}:${comment.revision}`));
  updateThread(threadId, (draft) => {
    const fileComments = (draft.fileComments ?? []).filter(
      (comment) => !takenRevisions.has(`${comment.id}:${comment.revision}`),
    );
    return { ...draft, fileComments, fileCommentEditor: keepEditorOfSentComment(draft.fileCommentEditor, fileComments) };
  });
}

/** Puts Files comments from a queued message back into the draft as new revisions. */
export function restoreQueuedFileComments(threadId: string, comments: readonly FileAnnotationPayload[]): void {
  if (comments.length === 0) return;
  updateThread(threadId, (draft) => comments.reduce<ComposerDraft>((next, comment) => {
    const { filePath, line, lineContent } = comment;
    return saveFileComment(
      next,
      { filePath, line, lineContent },
      { note: comment.note, mentions: comment.mentions ?? [] },
      comment.id,
    );
  }, draft));
}
