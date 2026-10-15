import type { PreviewPageRecord, SavedPreviewAnnotation } from "../state/previewAnnotationStore";

/** One page's notes as the composer tile shows them. */
export interface BrowserNoteGroup {
  readonly page: PreviewPageRecord;
  /** Notes in the page's own numbering order. */
  readonly notes: readonly SavedPreviewAnnotation[];
  /** Creation time of the page's newest note; the page annotated last fronts the stack. */
  readonly lastNotedAt: number;
}

/** Groups a thread's notes by page, most recently annotated page first. Notes without a page record are dropped. */
export function groupBrowserNotes(
  notes: readonly SavedPreviewAnnotation[],
  pages: Readonly<Record<string, PreviewPageRecord>>,
): BrowserNoteGroup[] {
  const byPage = new Map<string, SavedPreviewAnnotation[]>();
  for (const note of notes) {
    if (!pages[note.pageIdentity]) continue;
    byPage.set(note.pageIdentity, [...(byPage.get(note.pageIdentity) ?? []), note]);
  }
  const groups: BrowserNoteGroup[] = [];
  for (const [pageIdentity, pageNotes] of byPage) {
    const page = pages[pageIdentity];
    if (!page) continue;
    groups.push({
      page,
      notes: [...pageNotes].sort((a, b) => a.displayNumber - b.displayNumber),
      lastNotedAt: Math.max(...pageNotes.map((note) => note.createdAt)),
    });
  }
  return groups.sort((a, b) => b.lastNotedAt - a.lastNotedAt);
}

/** A page's display name: its title, else its host. */
export function browserPageLabel(page: Pick<PreviewPageRecord, "title" | "url">): string {
  const title = page.title?.trim();
  if (title) return title;
  try {
    return new URL(page.url).host;
  } catch {
    return page.url;
  }
}

function noteCount(count: number): string {
  return `${count} note${count === 1 ? "" : "s"}`;
}

/** Tile label, "Billing · 1 note" for one page and "4 notes · 2 pages" for several. */
export function browserNotesTileLabel(groups: readonly BrowserNoteGroup[]): string {
  const [front] = groups;
  if (!front) return "";
  if (groups.length === 1) return `${browserPageLabel(front.page)} · ${noteCount(front.notes.length)}`;
  const total = groups.reduce((sum, group) => sum + group.notes.length, 0);
  return `${noteCount(total)} · ${groups.length} pages`;
}
