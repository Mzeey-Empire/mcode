import {
  readPreviewAnnotationBundle,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";
import { browserPageLabel } from "./browserNoteGroups";

/** A page's snapshot as the sent tile can open it. */
export interface SentNotesSnapshot {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}

/** One page of a sent message's notes, in the numbering its snapshot's markers carry. */
export interface SentNotesPage {
  readonly pageIdentity: string;
  readonly label: string;
  readonly snapshot: SentNotesSnapshot | null;
  readonly notes: readonly { readonly id: string; readonly displayNumber: number; readonly target: string; readonly text: string }[];
}

/** A Review or Files line comment that travelled with the notes. */
export interface SentCodeComment {
  readonly id: string;
  readonly displayNumber: number;
  readonly filePath: string;
  readonly location: string;
  readonly text: string;
}

/** What a sent or queued message's feedback bundle shows. */
export interface SentNotesModel {
  readonly pages: readonly SentNotesPage[];
  /** The page annotated last; its snapshot fronts the tile. */
  readonly front: SentNotesPage | undefined;
  readonly codeComments: readonly SentCodeComment[];
  /** "4 notes", "2 comments" or both. */
  readonly label: string;
  /** Page names, or the commented files when no page carries notes. */
  readonly detail: string;
  /** Attachment ids the tile owns, so the attachment row does not repeat them. Covers v1 per-note snapshots. */
  readonly snapshotIds: ReadonlySet<string>;
}

function count(total: number, singular: string): string {
  return `${total} ${singular}${total === 1 ? "" : "s"}`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Reads a v1 or v2 bundle into what the tile and its card render, or null when it holds neither notes nor comments. */
export function readSentNotes(bundle: PreviewAnnotationBundle): SentNotesModel | null {
  const view = readPreviewAnnotationBundle(bundle);
  const pages: SentNotesPage[] = view.pages.map((page) => ({
    pageIdentity: page.pageIdentity,
    label: browserPageLabel(page),
    snapshot: page.snapshot ? { id: page.snapshot.id, name: page.snapshot.name, mimeType: page.snapshot.mimeType } : null,
    notes: page.notes.map((note) => ({
      id: note.id,
      displayNumber: note.displayNumber,
      target: note.targetContext.label?.trim() || note.targetContext.selectorHint?.trim() || "element",
      text: note.note.trim() || "Visual annotation",
    })),
  }));
  const codeComments: SentCodeComment[] = [...view.diffAnnotations, ...view.fileAnnotations].map((item) => ({
    id: item.id,
    displayNumber: item.displayNumber,
    filePath: item.filePath,
    location: `${item.filePath}:${item.line}`,
    text: item.note.trim(),
  }));
  if (pages.length === 0 && codeComments.length === 0) return null;

  const lastNote = [...bundle.annotations].reverse().find((item) => "pageIdentity" in item);
  const lastPage = lastNote && "pageIdentity" in lastNote ? lastNote.pageIdentity : undefined;
  const noteTotal = pages.reduce((sum, page) => sum + page.notes.length, 0);
  const label = [
    ...(noteTotal > 0 ? [count(noteTotal, "note")] : []),
    ...(codeComments.length > 0 ? [count(codeComments.length, "comment")] : []),
  ].join(" · ");
  const detail = pages.length > 0
    ? pages.map((page) => page.label).join(", ")
    : [...new Set(codeComments.map((comment) => fileName(comment.filePath)))].join(", ");
  return {
    pages,
    front: pages.find((page) => page.pageIdentity === lastPage) ?? pages[0],
    codeComments,
    label,
    detail,
    snapshotIds: new Set(view.pages.flatMap((page) => page.snapshotIds)),
  };
}
