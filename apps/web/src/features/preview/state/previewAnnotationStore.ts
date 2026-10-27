import { create } from "zustand";
import type { BrowserPreviewBounds, McodeBrowserCaptureV2 } from "@mcode/contracts/models/browser-preview";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { projectBrowserNotes, type PreviewPageRecord, type SavedPreviewAnnotation } from "./previewNoteView";

export type {
  PreviewCleanCapture,
  PreviewPageRecord,
  SavedPreviewAnnotation,
  StagedCleanCapture,
} from "./previewNoteView";

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

interface PreviewAnnotationStore {
  /**
   * Current Browser notes per thread, read from the composer draft. Only the
   * subscription below writes it; change the draft to change the notes.
   */
  readonly byThread: Record<string, SavedPreviewAnnotation[]>;
  /** Page records keyed by thread id, then page identity, read from the composer draft. */
  readonly pages: Record<string, Record<string, PreviewPageRecord>>;
  /** Active unsaved drafts keyed by thread id. An open bubble is not persisted. */
  readonly drafts: Record<string, PreviewDraftAnnotation | undefined>;
  /** Returns all saved notes for a thread in creation order. */
  getThreadAnnotations(threadId: string): SavedPreviewAnnotation[];
  /** Returns saved notes for a normalized page identity in display order. */
  getPageAnnotations(threadId: string, pageIdentity: string): SavedPreviewAnnotation[];
  /** Starts or replaces the thread's open bubble. */
  setDraft(threadId: string, draft: PreviewDraftAnnotation | undefined): void;
}

/** Moves viewport bounds captured at a scroll offset into document pixels. */
export function toDocumentBounds(
  bounds: BrowserPreviewBounds,
  scroll: McodeBrowserCaptureV2["viewportScroll"],
): BrowserPreviewBounds {
  return { ...bounds, x: bounds.x + (scroll?.scrollX ?? 0), y: bounds.y + (scroll?.scrollY ?? 0) };
}

/** Turns a bubble into the note the draft stores, with bounds in document pixels. */
export function toBrowserNoteContent(draft: PreviewDraftAnnotation) {
  return {
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

/** Zustand store for thread-scoped Browser notes, a live view over the composer draft. */
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
}));

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function viewThread(threadId: string): void {
  const { notes, pages } = projectBrowserNotes(useComposerDraftStore.getState().drafts[threadId]);
  usePreviewAnnotationStore.setState((state) => ({
    byThread: notes.length > 0 ? { ...state.byThread, [threadId]: notes } : withoutKey(state.byThread, threadId),
    pages: notes.length > 0 ? { ...state.pages, [threadId]: pages } : withoutKey(state.pages, threadId),
  }));
}

for (const threadId of Object.keys(useComposerDraftStore.getState().drafts)) viewThread(threadId);

useComposerDraftStore.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  for (const threadId of new Set([...Object.keys(state.drafts), ...Object.keys(previous.drafts)])) {
    const next = state.drafts[threadId];
    const before = previous.drafts[threadId];
    if (next?.browserNotePages !== before?.browserNotePages || next?.submissions !== before?.submissions) {
      viewThread(threadId);
    }
  }
});
