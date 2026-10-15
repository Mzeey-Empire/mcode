import { create } from "zustand";
import type {
  BrowserPreviewBounds,
  McodeBrowserCaptureV2,
  PreviewAnnotationBundle,
  PreviewAnnotationPage,
  PreviewAnnotationPayloadV2,
} from "@mcode/contracts";
import { PreviewAnnotationBundleSchema, readPreviewAnnotationBundle } from "@mcode/contracts";

/** The outbound shape; v1 bundles only arrive from history. */
export type PreviewAnnotationBundleV2 = Extract<PreviewAnnotationBundle, { schemaVersion: 2 }>;

/** Draft data captured from the Preview before it becomes a saved note. */
export interface PreviewDraftAnnotation {
  /** Thread that owns the draft. */
  readonly threadId: string;
  /** Normalized page identity used for visibility and grouping. */
  readonly pageIdentity: string;
  /** Target bounds in Preview viewport CSS pixels at the page's capture scroll. */
  readonly bounds: BrowserPreviewBounds;
  /** Optional selector hint from capture context. */
  readonly selectorHint?: string | null;
  /** Optional target label from capture context. */
  readonly label?: string | null;
  readonly pageContext: McodeBrowserCaptureV2;
  /** User note text. */
  readonly note: string;
}

/** Saved note with stable identity and creation ordering. Bounds are document pixels. */
export interface SavedPreviewAnnotation extends PreviewAnnotationPayloadV2 {
  /** Stable sort key independent of display number. */
  readonly createdAt: number;
}

/** The unmarked viewport screenshot a page's marked snapshot is redrawn from. */
export interface PreviewCleanCapture {
  /** PNG bytes of the page viewport with no markers. */
  readonly bytes: Uint8Array;
  /** Page context at the moment of capture; its bounds give the viewport size in CSS pixels. */
  readonly capture: McodeBrowserCaptureV2;
  readonly scroll: { readonly x: number; readonly y: number };
}

/** One page of notes: its identity, its clean screenshot, and the marked image that rides the send. */
export interface PreviewPageRecord {
  readonly pageIdentity: string;
  readonly url: string;
  readonly title: string | null;
  readonly faviconUrl: string | null;
  /** Null after a restore, when only the marked image survived; a new note on the page captures a fresh one. */
  readonly clean: PreviewCleanCapture | null;
  /** Null until the first redraw lands, and again once the page's notes change. */
  readonly marked: PreviewAnnotationPage["snapshot"] | null;
  /** Bytes of the marked image, for the tile thumbnail; null once the image is only a stored attachment. */
  readonly markedPng: Uint8Array | null;
}

interface PreviewAnnotationStore {
  readonly byThread: Record<string, SavedPreviewAnnotation[]>;
  /** Page records keyed by thread id, then page identity. */
  readonly pages: Record<string, Record<string, PreviewPageRecord>>;
  /** Active unsaved drafts keyed by thread id. */
  readonly drafts: Record<string, PreviewDraftAnnotation | undefined>;
  /** Returns all saved notes for a thread in creation order. */
  getThreadAnnotations(threadId: string): SavedPreviewAnnotation[];
  /** Returns saved notes for a normalized page identity in display order. */
  getPageAnnotations(threadId: string, pageIdentity: string): SavedPreviewAnnotation[];
  /** Starts or replaces the thread draft. */
  setDraft(threadId: string, draft: PreviewDraftAnnotation | undefined): void;
  /** Records a page's fresh clean screenshot; its marked image is stale until redrawn. */
  setPageCapture(threadId: string, page: Omit<PreviewPageRecord, "marked" | "markedPng">): void;
  setPageSnapshot(
    threadId: string,
    pageIdentity: string,
    marked: PreviewAnnotationPage["snapshot"],
    markedPng: Uint8Array | null,
  ): void;
  /** Saves a draft or an edited note. The draft's page needs a captured record. */
  saveAnnotation(threadId: string, draft: PreviewDraftAnnotation, id?: string): SavedPreviewAnnotation;
  /** Deletes one saved note by stable id and renumbers its page. */
  deleteAnnotation(threadId: string, id: string): void;
  /** Clears a thread's Browser notes and their pages. Review and Files comments are not touched. */
  clearPreviewNotes(threadId: string): void;
  /** Clears everything the store holds for a thread; used when the thread itself goes away. */
  clearThread(threadId: string): void;
  /** Puts back notes and pages exactly as they were, clean screenshots included, after a failed send. */
  reinstate(threadId: string, notes: SavedPreviewAnnotation[], pages: Record<string, PreviewPageRecord>): void;
  /** Restores the Browser notes of a validated outbound bundle; diff comments belong to the composer draft. */
  restoreBundle(threadId: string, bundle: PreviewAnnotationBundle | undefined): boolean;
  buildBundle(threadId: string): PreviewAnnotationBundleV2 | undefined;
}

function renumberPage(
  notes: readonly SavedPreviewAnnotation[],
  pageIdentity: string,
): SavedPreviewAnnotation[] {
  const numbers = new Map(
    notes
      .filter((note) => note.pageIdentity === pageIdentity)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((note, index) => [note.id, index + 1] as const),
  );
  return notes.map((note) => {
    const displayNumber = numbers.get(note.id);
    return displayNumber === undefined || displayNumber === note.displayNumber
      ? note
      : { ...note, displayNumber };
  });
}

/** Moves viewport bounds captured at a scroll offset into document pixels. */
export function toDocumentBounds(
  bounds: BrowserPreviewBounds,
  scroll: McodeBrowserCaptureV2["viewportScroll"],
): BrowserPreviewBounds {
  return { ...bounds, x: bounds.x + (scroll?.scrollX ?? 0), y: bounds.y + (scroll?.scrollY ?? 0) };
}

function savedPreviewAnnotation(
  existing: readonly SavedPreviewAnnotation[],
  draft: PreviewDraftAnnotation,
  id: string | undefined,
): SavedPreviewAnnotation {
  const previous = id ? existing.find((row) => row.id === id) : undefined;
  return {
    id: id ?? crypto.randomUUID(),
    createdAt: previous?.createdAt ?? Date.now(),
    displayNumber: previous?.displayNumber ?? 1,
    pageIdentity: draft.pageIdentity,
    pageContext: draft.pageContext,
    targetContext: {
      label: draft.label ?? null,
      selectorHint: draft.selectorHint ?? null,
      bounds: toDocumentBounds(draft.bounds, draft.pageContext.viewportScroll),
    },
    note: draft.note.trim(),
  };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function pageSnapshotRecord(
  pages: Record<string, Record<string, PreviewPageRecord>>,
  threadId: string,
  pageIdentity: string,
  update: (page: PreviewPageRecord) => PreviewPageRecord,
): Record<string, Record<string, PreviewPageRecord>> {
  const page = pages[threadId]?.[pageIdentity];
  if (!page) return pages;
  return { ...pages, [threadId]: { ...pages[threadId], [pageIdentity]: update(page) } };
}

/** Zustand store for thread-scoped Browser notes. */
export const usePreviewAnnotationStore = create<PreviewAnnotationStore>((set, get) => ({
  byThread: {},
  pages: {},
  drafts: {},

  getThreadAnnotations(threadId) {
    return get().byThread[threadId] ?? [];
  },

  getPageAnnotations(threadId, pageIdentity) {
    return (get().byThread[threadId] ?? [])
      .filter((annotation) => annotation.pageIdentity === pageIdentity)
      .sort((a, b) => a.displayNumber - b.displayNumber);
  },

  setDraft(threadId, draft) {
    set((state) => ({
      drafts: { ...state.drafts, [threadId]: draft },
    }));
  },

  setPageCapture(threadId, page) {
    set((state) => ({
      pages: {
        ...state.pages,
        [threadId]: { ...state.pages[threadId], [page.pageIdentity]: { ...page, marked: null, markedPng: null } },
      },
    }));
  },

  setPageSnapshot(threadId, pageIdentity, marked, markedPng) {
    set((state) => ({
      pages: pageSnapshotRecord(state.pages, threadId, pageIdentity, (page) => ({ ...page, marked, markedPng })),
    }));
  },

  saveAnnotation(threadId, draft, id) {
    if (!draft.note.trim()) {
      throw new Error("annotation note is required");
    }
    if (!get().pages[threadId]?.[draft.pageIdentity]) {
      throw new Error("page capture is required before saving a note");
    }
    const existing = get().byThread[threadId] ?? [];
    const annotation = savedPreviewAnnotation(existing, draft, id);
    const appended = id
      ? existing.map((row) => row.id === id ? annotation : row)
      : [...existing, annotation];
    const next = renumberPage(appended, draft.pageIdentity);
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: next },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return next.find((row) => row.id === annotation.id) ?? annotation;
  },

  deleteAnnotation(threadId, id) {
    const existing = get().byThread[threadId] ?? [];
    const removed = existing.find((row) => row.id === id);
    if (!removed) return;
    const remaining = renumberPage(existing.filter((row) => row.id !== id), removed.pageIdentity);
    const pageEmpty = !remaining.some((row) => row.pageIdentity === removed.pageIdentity);
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: remaining },
      pages: pageEmpty
        ? { ...state.pages, [threadId]: withoutKey(state.pages[threadId] ?? {}, removed.pageIdentity) }
        : pageSnapshotRecord(state.pages, threadId, removed.pageIdentity, (page) => ({ ...page, marked: null, markedPng: null })),
    }));
  },

  clearPreviewNotes(threadId) {
    set((state) => ({
      byThread: withoutKey(state.byThread, threadId),
      pages: withoutKey(state.pages, threadId),
    }));
  },

  clearThread(threadId) {
    get().clearPreviewNotes(threadId);
    set((state) => ({ drafts: withoutKey(state.drafts, threadId) }));
  },

  reinstate(threadId, notes, pages) {
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: notes },
      pages: { ...state.pages, [threadId]: pages },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
  },

  restoreBundle(threadId, bundle) {
    if (!bundle) {
      get().clearThread(threadId);
      return true;
    }
    const parsed = PreviewAnnotationBundleSchema().safeParse(bundle);
    if (!parsed.success) {
      get().clearThread(threadId);
      return false;
    }
    const view = readPreviewAnnotationBundle(parsed.data);
    const baseCreatedAt = Date.now();
    const notes: SavedPreviewAnnotation[] = [];
    const pages: Record<string, PreviewPageRecord> = {};
    for (const page of view.pages) {
      if (page.notes.length === 0) continue;
      pages[page.pageIdentity] = {
        pageIdentity: page.pageIdentity,
        url: page.url,
        title: page.title,
        faviconUrl: page.faviconUrl,
        clean: null,
        marked: page.snapshot ? { ...page.snapshot } : null,
        markedPng: null,
      };
      for (const note of page.notes) {
        notes.push({
          ...note,
          pageIdentity: page.pageIdentity,
          createdAt: baseCreatedAt + notes.length,
        });
      }
    }
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: notes },
      pages: { ...state.pages, [threadId]: pages },
      drafts: { ...state.drafts, [threadId]: undefined },
    }));
    return true;
  },

  buildBundle(threadId) {
    const notes = get().byThread[threadId] ?? [];
    if (notes.length === 0) return undefined;
    const pageRecords = get().pages[threadId] ?? {};
    const sendable = notes.filter((note) => pageRecords[note.pageIdentity]?.marked);
    if (sendable.length === 0) return undefined;
    const pageIdentities = [...new Set(sendable.map((note) => note.pageIdentity))];
    return {
      schemaVersion: 2,
      pages: pageIdentities.map((pageIdentity) => {
        const { url, title, faviconUrl, marked } = pageRecords[pageIdentity]!;
        return { pageIdentity, url, title, faviconUrl, snapshot: marked! };
      }),
      annotations: [...sendable]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ createdAt: _createdAt, ...note }) => note),
    };
  },
}));
