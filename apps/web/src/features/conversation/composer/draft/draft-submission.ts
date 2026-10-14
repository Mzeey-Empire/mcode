import type {
  DiffAnnotationPayload,
  DraftDiffComment,
  DraftSubmission,
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
}

/** Line target of a Review comment. */
export type DiffCommentTarget = Pick<DiffAnnotationPayload, "filePath" | "side" | "line" | "lineContent">;

/** Note text and mentions entered for a Review comment. */
export interface DiffCommentContent {
  readonly note: string;
  readonly mentions: readonly MessageMention[];
}

/** What a Send carries, frozen at the moment of Send. */
export interface FrozenDraftContent {
  readonly diffComments: readonly DraftDiffComment[];
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

/** Comments a user can see and edit: every current revision no pending Send holds. */
export function visibleDiffComments(draft: NextMessageDraft): DraftDiffComment[] {
  const held = heldRevisionKeys(draft);
  return (draft.diffComments ?? []).filter(
    (comment) => !held.has(`diffComments:${comment.id}:${comment.revision}`),
  );
}

/** Reads what the next Send would carry now. */
export function readSendableDraftContent(draft: NextMessageDraft): FrozenDraftContent {
  return { diffComments: visibleDiffComments(draft) };
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
    elements: content.diffComments.map((comment) => ({
      field: "diffComments" as const,
      id: comment.id,
      revision: comment.revision,
    })),
    stagingIds: [],
  };
  return { draft: { ...draft, submissions: [...(draft.submissions ?? []), submission] }, submission };
}

/** An unsaved edit of a comment that was just sent keeps its text as a new comment. */
export function keepEditorOfSentComment<E extends { readonly annotationId?: string }>(
  editor: E | undefined,
  remaining: readonly DraftDiffComment[],
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
  const sent = new Set(
    submission.elements
      .filter((element) => element.field === "diffComments")
      .map((element) => `${element.id}:${element.revision}`),
  );
  const diffComments = (draft.diffComments ?? []).filter(
    (comment) => !sent.has(`${comment.id}:${comment.revision}`),
  );
  return {
    ...draft,
    diffComments,
    diffCommentEditor: keepEditorOfSentComment(draft.diffCommentEditor, diffComments),
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
