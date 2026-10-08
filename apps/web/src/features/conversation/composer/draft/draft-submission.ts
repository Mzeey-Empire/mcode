import type {
  DiffAnnotationPayload,
  DraftDiffComment,
  DraftSubmission,
  MessageMention,
  PlanCommentSelection,
} from "@mcode/contracts";

/**
 * The next-message part of a persisted composer draft: everything that rides
 * the next Send besides the composer text. Pure rules over this shape decide
 * what a Send freezes and what settling it leaves behind.
 */
export interface NextMessageDraft {
  /** Saved Review line comments, one element each. */
  readonly diffComments?: readonly DraftDiffComment[];
  /** Plan comments chosen to ride the next Send; rendered by S07-06. */
  readonly planCommentSelection?: PlanCommentSelection;
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

/** One plan comment as the server records it, for reconciling the selection. */
export interface PlanCommentRecord {
  readonly id: string;
  /** Only open, unsent comments can ride a Send. */
  readonly open: boolean;
  /** Set when the comment was copied forward from an earlier plan version. */
  readonly carriedFromCommentId?: string;
}

/** What a Send carries, frozen at the moment of Send. */
export interface FrozenDraftContent {
  readonly diffComments: readonly DraftDiffComment[];
  readonly planComments?: { readonly ridingIds: string[]; readonly excludedIds: string[] };
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

/** The plan selection a Send can carry, or nothing while a pending Send holds it. */
export function visiblePlanCommentSelection(draft: NextMessageDraft): PlanCommentSelection | undefined {
  const selection = draft.planCommentSelection;
  if (!selection) return undefined;
  const held = heldRevisionKeys(draft);
  return held.has(`planCommentSelection:${selection.planVersionId}:${selection.revision}`)
    ? undefined
    : selection;
}

/** Reads what the next Send would carry now. */
export function readSendableDraftContent(draft: NextMessageDraft): FrozenDraftContent {
  const selection = visiblePlanCommentSelection(draft);
  return {
    diffComments: visibleDiffComments(draft),
    planComments: selection && {
      ridingIds: selection.includedIds.filter((id) => !selection.excludedIds.includes(id)),
      excludedIds: [...selection.excludedIds],
    },
  };
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
  const selection = draft.planCommentSelection;
  const submission: DraftSubmission = {
    messageId,
    elements: [
      ...content.diffComments.map((comment) => ({
        field: "diffComments" as const,
        id: comment.id,
        revision: comment.revision,
      })),
      ...(content.planComments && selection
        ? [{ field: "planCommentSelection" as const, id: selection.planVersionId, revision: selection.revision }]
        : []),
    ],
    planComments: content.planComments && {
      ridingIds: [...content.planComments.ridingIds],
      excludedIds: [...content.planComments.excludedIds],
    },
    stagingIds: [],
  };
  return { draft: { ...draft, submissions: [...(draft.submissions ?? []), submission] }, submission };
}

function settleSuccessfulPlanSelection(
  selection: PlanCommentSelection | undefined,
  submission: DraftSubmission,
): PlanCommentSelection | undefined {
  if (!selection || !submission.planComments) return selection;
  const { ridingIds, excludedIds } = submission.planComments;
  if (selection.planVersionId !== submission.elements.find((element) => element.field === "planCommentSelection")?.id) {
    return selection;
  }
  // An exclusion applies to one Send, so the frozen exclusions end with it.
  return {
    ...selection,
    includedIds: selection.includedIds.filter((id) => !ridingIds.includes(id)),
    excludedIds: selection.excludedIds.filter((id) => !excludedIds.includes(id)),
    revision: selection.revision + 1,
  };
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
    planCommentSelection: settleSuccessfulPlanSelection(draft.planCommentSelection, submission),
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

/**
 * Reconciles the plan-comment selection with the plan's authoritative comment
 * list. Ids whose comment is gone, resolved or sent are dropped. A comment in
 * neither list joins the side of the comment it was carried from, else it is
 * included. Returns the same object when nothing changed.
 */
export function reconcilePlanCommentSelection(
  selection: PlanCommentSelection,
  comments: readonly PlanCommentRecord[],
): PlanCommentSelection {
  const open = comments.filter((comment) => comment.open);
  const openIds = new Set(open.map((comment) => comment.id));
  const excluded = new Set(selection.excludedIds);
  const known = new Set([...selection.includedIds, ...selection.excludedIds]);
  const includedIds = selection.includedIds.filter((id) => openIds.has(id));
  const excludedIds = selection.excludedIds.filter((id) => openIds.has(id));
  for (const comment of open) {
    if (known.has(comment.id)) continue;
    const carriedExcluded = comment.carriedFromCommentId !== undefined && excluded.has(comment.carriedFromCommentId);
    (carriedExcluded ? excludedIds : includedIds).push(comment.id);
  }
  const unchanged = includedIds.length === selection.includedIds.length
    && excludedIds.length === selection.excludedIds.length
    && includedIds.every((id, index) => id === selection.includedIds[index])
    && excludedIds.every((id, index) => id === selection.excludedIds[index]);
  return unchanged ? selection : { ...selection, includedIds, excludedIds, revision: selection.revision + 1 };
}
