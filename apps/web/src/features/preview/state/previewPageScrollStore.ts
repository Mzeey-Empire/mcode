import { create } from "zustand";

/** Scroll offset of a guest page's main document in CSS pixels. */
export interface PreviewPageScroll {
  readonly x: number;
  readonly y: number;
}

interface PreviewPageScrollStore {
  readonly byTab: Record<string, PreviewPageScroll>;
  report: (threadId: string, tabId: string, scroll: PreviewPageScroll) => void;
}

const ORIGIN: PreviewPageScroll = { x: 0, y: 0 };

/** Key of one thread tab in the scroll store. */
export function pageScrollKey(threadId: string, tabId: string): string {
  return `${threadId}:${tabId}`;
}

/** Live scroll offset of each guest page. */
export const usePreviewPageScrollStore = create<PreviewPageScrollStore>((set, get) => ({
  byTab: {},
  report: (threadId, tabId, scroll) => {
    const key = pageScrollKey(threadId, tabId);
    const current = get().byTab[key];
    if (current && current.x === scroll.x && current.y === scroll.y) return;
    set({ byTab: { ...get().byTab, [key]: scroll } });
  },
}));

/** Subscribes to one tab's scroll offset; a tab that has not reported sits at the origin. */
export function usePreviewPageScroll(threadId: string, tabId: string | null | undefined): PreviewPageScroll {
  return usePreviewPageScrollStore((s) => (tabId ? s.byTab[pageScrollKey(threadId, tabId)] : undefined) ?? ORIGIN);
}
