import type { DiffAnnotationPayload, FileAnnotationPayload, PreviewAnnotationPayloadV2 } from "@mcode/contracts/models/browser-preview";
import type { DraftBrowserNote, DraftBrowserNotePage, DraftDiffComment, DraftElementField, DraftElementMeta, DraftFileComment, DraftSubmission, StagedDraftImage } from "@mcode/contracts/models/next-message-draft";
import type { MessageMention } from "@mcode/contracts/models/mention";

/**
 * The next-message part of a persisted composer draft: everything that rides
 * the next Send besides the composer text. Pure rules over this shape decide
 * what a Send freezes and what settling it leaves behind.
 */
export interface NextMessageDraft {
  /** Browser pages with their saved notes and staged captures. */
  readonly browserNotePages?: readonly DraftBrowserNotePage[];
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
  /** Pages narrowed to the notes this Send carries. */
  readonly browserNotePages: readonly DraftBrowserNotePage[];
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

/**
 * Pages a user can see and edit, narrowed to the notes no pending Send holds
 * and numbered per page in creation order. A page whose notes are all held is
 * not visible.
 */
export function visibleBrowserNotePages(draft: NextMessageDraft): DraftBrowserNotePage[] {
  const held = heldRevisionKeys(draft);
  return (draft.browserNotePages ?? []).flatMap((page) => {
    const notes = page.notes
      .filter((note) => !held.has(`browserNotePages:${note.id}:${note.revision}`))
      .map((note, index) => ({ ...note, displayNumber: index + 1 }));
    return notes.length > 0 ? [{ ...page, notes }] : [];
  });
}

/** What a Browser page keeps besides its notes, taken when a note is saved. */
export type BrowserPageCapture = Omit<DraftBrowserNotePage, "snapshot" | "notes">;

/** A Browser note before the draft gives it an identity, revision and number. */
export type BrowserNoteContent = Omit<PreviewAnnotationPayloadV2, "id" | "displayNumber">;

function upsertNote(
  notes: readonly DraftBrowserNote[],
  content: BrowserNoteContent,
  id: string | undefined,
): DraftBrowserNote[] {
  const existing = notes.find((candidate) => candidate.id === id);
  if (!existing) {
    return [...notes, { ...content, id: crypto.randomUUID(), revision: 1, displayNumber: notes.length + 1 }];
  }
  const edited = { ...content, id: existing.id, revision: existing.revision + 1, displayNumber: existing.displayNumber };
  return notes.map((candidate) => (candidate === existing ? edited : candidate));
}

/**
 * Saves a Browser note at revision 1, or writes the next revision of an
 * existing one. Every save replaces the page's clean capture and voids its
 * snapshot, so the next redraw shows the notes as they are now.
 */
export function saveBrowserNote<T extends NextMessageDraft>(
  draft: T,
  page: BrowserPageCapture,
  content: BrowserNoteContent,
  id?: string,
): T {
  const pages = draft.browserNotePages ?? [];
  const current = pages.find((candidate) => candidate.pageIdentity === page.pageIdentity);
  const saved: DraftBrowserNotePage = { ...page, snapshot: null, notes: upsertNote(current?.notes ?? [], content, id) };
  return {
    ...draft,
    // The latest-annotated page goes last, so tile order follows when each page was touched.
    browserNotePages: [...pages.filter((candidate) => candidate !== current), saved],
  };
}

/** Drops this draft's reference to a Browser note and voids its page's snapshot. Staged files stay. */
export function removeBrowserNote<T extends NextMessageDraft>(draft: T, id: string): T {
  return {
    ...draft,
    browserNotePages: (draft.browserNotePages ?? []).flatMap((page) => {
      if (!page.notes.some((note) => note.id === id)) return [page];
      const notes = page.notes.filter((note) => note.id !== id);
      return notes.length > 0 ? [{ ...page, snapshot: null, notes }] : [];
    }),
  };
}

/** Records the freshly drawn snapshot of a page, replacing the reference to the old one. */
export function setBrowserPageSnapshot<T extends NextMessageDraft>(
  draft: T,
  pageIdentity: string,
  snapshot: StagedDraftImage,
): T {
  return {
    ...draft,
    browserNotePages: (draft.browserNotePages ?? []).map((page) =>
      page.pageIdentity === pageIdentity ? { ...page, snapshot } : page),
  };
}

/** Reads what the next Send would carry now. */
export function readSendableDraftContent(draft: NextMessageDraft): FrozenDraftContent {
  return {
    browserNotePages: visibleBrowserNotePages(draft),
    diffComments: visibleDiffComments(draft),
    fileComments: visibleFileComments(draft),
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
      ...submittedElements("browserNotePages", content.browserNotePages.flatMap((page) => page.notes)),
    ],
    stagingIds: content.browserNotePages.flatMap((page) => (page.snapshot ? [page.snapshot.stagingId] : [])),
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
 * On success drops the submitted notes still at their submitted revision. A
 * page that now mixes sent-time and later notes renumbers and loses its
 * snapshot, since the marks it shows no longer match its notes. A page left
 * without notes goes away. A failed Send leaves a page alone unless notes
 * were added to it meanwhile.
 */
function settleBrowserNotePages(
  pages: readonly DraftBrowserNotePage[],
  sent: ReadonlySet<string>,
  outcome: "success" | "failure",
): DraftBrowserNotePage[] {
  return pages.flatMap((page) => {
    const carried = page.notes.filter((note) => sent.has(`browserNotePages:${note.id}:${note.revision}`));
    if (carried.length === 0) return [page];
    if (outcome === "failure" && carried.length === page.notes.length) return [page];
    const notes = outcome === "success" ? page.notes.filter((note) => !carried.includes(note)) : page.notes;
    if (notes.length === 0) return [];
    return [{
      ...page,
      snapshot: null,
      notes: notes.map((note, index) => ({ ...note, displayNumber: index + 1 })),
    }];
  });
}

/**
 * Removes Browser notes a queued message took with it, unless they were edited
 * since; a later revision is a new note the message does not own.
 */
export function removeTakenBrowserNotes<T extends NextMessageDraft>(
  draft: T,
  taken: readonly DraftElementMeta[],
): T {
  if (taken.length === 0) return draft;
  const keys = new Set(taken.map((note) => `browserNotePages:${note.id}:${note.revision}`));
  return { ...draft, browserNotePages: settleBrowserNotePages(draft.browserNotePages ?? [], keys, "success") };
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
  const sent = new Set(submission.elements.map((element) => `${element.field}:${element.id}:${element.revision}`));
  const browserNotePages = settleBrowserNotePages(draft.browserNotePages ?? [], sent, outcome);
  if (outcome === "failure") return { ...draft, browserNotePages, submissions };
  const diffComments = (draft.diffComments ?? []).filter(
    (comment) => !sent.has(`diffComments:${comment.id}:${comment.revision}`),
  );
  const fileComments = (draft.fileComments ?? []).filter(
    (comment) => !sent.has(`fileComments:${comment.id}:${comment.revision}`),
  );
  return {
    ...draft,
    browserNotePages,
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
