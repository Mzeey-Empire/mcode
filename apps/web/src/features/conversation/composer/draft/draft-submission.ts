import type {
  DiffAnnotationPayload,
  DraftDiffComment,
  DraftElementField,
  DraftElementMeta,
  DraftFileComment,
  DraftSubmission,
  FileAnnotationPayload,
  MessageMention,
} from "@mcode/contracts";

/**
 * The next-message part of a persisted composer draft: everything that rides
 * the next Send besides the composer text. Pure rules over this shape decide
 * what a Send freezes and what settling it leaves behind.
 */
export interface NextMessageDraft {
  /** Saved Review line comments, one element each. */
  readonly diffComments?: readonly DraftDiffComment[];
  /** Sends whose admission has not settled. */
  readonly submissions?: readonly DraftSubmission[];
  /** Open Review comment editor; only which comment it edits matters here. */
  readonly diffCommentEditor?: { readonly annotationId?: string };
  /** Saved Files line comments, one element each. */
  readonly fileComments?: readonly DraftFileComment[];
  /** Open Files comment editor; only which comment it edits matters here. */
  readonly fileCommentEditor?: { readonly annotationId?: string };
}

/** Line target of a Review comment. */
export type DiffCommentTarget = Pick<DiffAnnotationPayload, "filePath" | "side" | "line" | "lineContent">;

/** Line target of a Files comment. */
export type FileCommentTarget = Pick<FileAnnotationPayload, "filePath" | "line" | "lineContent">;

/** Note text and mentions entered for a Review or Files comment. */
export interface DiffCommentContent {
  readonly note: string;
  readonly mentions: readonly MessageMention[];
}

/** What a Send carries, frozen at the moment of Send. */
export interface FrozenDraftContent {
  readonly diffComments: readonly DraftDiffComment[];
  readonly fileComments: readonly DraftFileComment[];
}

function heldRevisionKeys(draft: NextMessageDraft): Set<string> {
  const keys = new Set<string>();
  for (const submission of draft.submissions ?? []) {
    for (const element of submission.elements) {
      keys.add(`${element.field}:${element.id}:${element.revision}`);
    }
  }
  return keys;
}

function unheldElements<E extends DraftElementMeta>(
  draft: NextMessageDraft,
  field: DraftElementField,
  elements: readonly E[] | undefined,
): E[] {
  const held = heldRevisionKeys(draft);
  return (elements ?? []).filter((element) => !held.has(`${field}:${element.id}:${element.revision}`));
}

/** Comments a user can see and edit: every current revision no pending Send holds. */
export function visibleDiffComments(draft: NextMessageDraft): DraftDiffComment[] {
  return unheldElements(draft, "diffComments", draft.diffComments);
}

/** Files comments a user can see and edit: every current revision no pending Send holds. */
export function visibleFileComments(draft: NextMessageDraft): DraftFileComment[] {
  return unheldElements(draft, "fileComments", draft.fileComments);
}

/** Reads what the next Send would carry now. */
export function readSendableDraftContent(draft: NextMessageDraft): FrozenDraftContent {
  return { diffComments: visibleDiffComments(draft), fileComments: visibleFileComments(draft) };
}

/** Saves a new comment at revision 1, or writes the next revision of an existing one. */
export function saveDiffComment<T extends NextMessageDraft>(
  draft: T,
  target: DiffCommentTarget,
  content: DiffCommentContent,
  id?: string,
): T {
  const comments = draft.diffComments ?? [];
  const existing = id ? comments.find((comment) => comment.id === id) : undefined;
  const comment: DraftDiffComment = {
    kind: "diff",
    id: existing?.id ?? crypto.randomUUID(),
    revision: existing ? existing.revision + 1 : 1,
    displayNumber: existing?.displayNumber ?? comments.length + 1,
    ...target,
    note: content.note,
    mentions: [...content.mentions],
  };
  return {
    ...draft,
    diffComments: existing
      ? comments.map((candidate) => (candidate.id === comment.id ? comment : candidate))
      : [...comments, comment],
  };
}

/** Drops this draft's reference to a comment. Staged files are never deleted here. */
export function removeDiffComment<T extends NextMessageDraft>(draft: T, id: string): T {
  return { ...draft, diffComments: (draft.diffComments ?? []).filter((comment) => comment.id !== id) };
}

/**
 * Saves a new Files comment at revision 1, or writes the next revision of an
 * existing one. A new comment takes the given id when there is one, so a queued
 * comment returning to the draft keeps its identity.
 */
export function saveFileComment<T extends NextMessageDraft>(
  draft: T,
  target: FileCommentTarget,
  content: DiffCommentContent,
  id?: string,
): T {
  const comments = draft.fileComments ?? [];
  const existing = id ? comments.find((comment) => comment.id === id) : undefined;
  const comment: DraftFileComment = {
    kind: "file",
    id: existing?.id ?? id ?? crypto.randomUUID(),
    revision: existing ? existing.revision + 1 : 1,
    displayNumber: existing?.displayNumber ?? comments.length + 1,
    filePath: target.filePath,
    line: target.line,
    lineContent: target.lineContent,
    note: content.note,
    mentions: [...content.mentions],
  };
  return {
    ...draft,
    fileComments: existing
      ? comments.map((candidate) => (candidate.id === comment.id ? comment : candidate))
      : [...comments, comment],
  };
}

/** Drops this draft's reference to a Files comment. */
export function removeFileComment<T extends NextMessageDraft>(draft: T, id: string): T {
  return { ...draft, fileComments: (draft.fileComments ?? []).filter((comment) => comment.id !== id) };
}

function submittedElements(field: DraftElementField, elements: readonly DraftElementMeta[]) {
  return elements.map((element) => ({ field, id: element.id, revision: element.revision }));
}

/**
 * Records what a Send carries. The elements stay in the draft, hidden by the
 * submission, so a failed Send returns them as they are now.
 */
export function freezeDraftSubmission<T extends NextMessageDraft>(
  draft: T,
  messageId: string,
  content: FrozenDraftContent,
): { draft: T; submission: DraftSubmission } {
  const submission: DraftSubmission = {
    messageId,
    elements: [
      ...submittedElements("diffComments", content.diffComments),
      ...submittedElements("fileComments", content.fileComments),
    ],
    stagingIds: [],
  };
  return { draft: { ...draft, submissions: [...(draft.submissions ?? []), submission] }, submission };
}

/** An unsaved edit of a comment that was just sent keeps its text as a new comment. */
export function keepEditorOfSentComment<E extends { readonly annotationId?: string }>(
  editor: E | undefined,
  remaining: readonly DraftElementMeta[],
): E | undefined {
  if (editor?.annotationId === undefined) return editor;
  return remaining.some((comment) => comment.id === editor.annotationId)
    ? editor
    : { ...editor, annotationId: undefined };
}

/**
 * Settles one Send. Success deletes each submitted element still at its
 * submitted revision and keeps newer revisions. Failure only drops the
 * submission, so every element returns with any later edits.
 */
export function settleDraftSubmission<T extends NextMessageDraft>(
  draft: T,
  messageId: string,
  outcome: "success" | "failure",
): T {
  const submission = draft.submissions?.find((candidate) => candidate.messageId === messageId);
  if (!submission) return draft;
  const submissions = (draft.submissions ?? []).filter((candidate) => candidate !== submission);
  if (outcome === "failure") return { ...draft, submissions };
  const sent = new Set(submission.elements.map((element) => `${element.field}:${element.id}:${element.revision}`));
  const diffComments = (draft.diffComments ?? []).filter(
    (comment) => !sent.has(`diffComments:${comment.id}:${comment.revision}`),
  );
  const fileComments = (draft.fileComments ?? []).filter(
    (comment) => !sent.has(`fileComments:${comment.id}:${comment.revision}`),
  );
  return {
    ...draft,
    diffComments,
    diffCommentEditor: keepEditorOfSentComment(draft.diffCommentEditor, diffComments),
    fileComments,
    fileCommentEditor: keepEditorOfSentComment(draft.fileCommentEditor, fileComments),
    submissions,
  };
}

/**
 * Resolves submissions no live Send in this window owns, after a restart or a
 * lost response: the thread holding the message means it was admitted.
 */
export function reconcilePendingSubmissions<T extends NextMessageDraft>(
  draft: T,
  isInFlight: (messageId: string) => boolean,
  threadHasMessage: (messageId: string) => boolean,
): T {
  let next = draft;
  for (const submission of draft.submissions ?? []) {
    if (isInFlight(submission.messageId)) continue;
    next = settleDraftSubmission(
      next,
      submission.messageId,
      threadHasMessage(submission.messageId) ? "success" : "failure",
    );
  }
  return next;
}
