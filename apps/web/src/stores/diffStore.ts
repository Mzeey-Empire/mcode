import { create } from "zustand";
import type { TurnSnapshot, GitCommit } from "@mcode/contracts";

export type { GitCommit };

/** Active tab in the right panel. */
export type RightPanelTab = "tasks" | "changes" | "preview";

/** View mode within the Changes tab. */
export type DiffViewMode = "by-turn" | "all" | "commits" | "summary";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 384;
/**
 * Fallback width when the viewport is unavailable (tests, SSR). Live UI uses half the
 * viewport via {@link getDefaultPanelWidthPx}.
 */
export const PANEL_DEFAULT_WIDTH = 380;
/** Wide snap target for the right panel (double-click drag handle). */
export const PANEL_WIDE_WIDTH = 680;

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, w);
}

/**
 * Returns the default panel width for the current window (50% of the viewport, clamped
 * to {@link PANEL_MIN_WIDTH}). Used when a thread has no stored width yet.
 */
export function getDefaultPanelWidthPx(): number {
  if (typeof globalThis.window === "undefined") return clampWidth(PANEL_DEFAULT_WIDTH);
  return clampWidth(Math.round(globalThis.window.innerWidth * 0.5));
}

/** Currently selected file for diff viewing. */
export interface SelectedFile {
  source: "snapshot" | "cumulative" | "commit";
  /** Snapshot ID or commit SHA depending on source. */
  id: string;
  filePath: string;
  /** Thread that owns this selection, used to clear on thread deletion. */
  threadId: string;
}

/** Per-thread right panel state (visibility, width, active tab). */
export type RightPanelState = {
  readonly visible: boolean;
  readonly width: number;
  readonly activeTab: RightPanelTab;
};

/**
 * Baseline right-panel state for a thread that has no persisted row (50% viewport width).
 */
export function createDefaultRightPanelState(): RightPanelState {
  return {
    visible: false,
    width: getDefaultPanelWidthPx(),
    activeTab: "tasks",
  };
}

/**
 * Static defaults for threads with no panel store row; live width uses
 * {@link getDefaultPanelWidthPx} through {@link createDefaultRightPanelState}.
 */
export const RIGHT_PANEL_DEFAULTS: RightPanelState = {
  visible: false,
  width: PANEL_DEFAULT_WIDTH,
  activeTab: "tasks",
} as const;

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Last preview URL typed or loaded per thread (in-memory only). */
  readonly previewUrlByThread: Record<string, string>;
  /** Per-thread right panel state keyed by thread ID. */
  readonly rightPanelByThread: Record<string, RightPanelState>;
  /** View mode within the Changes tab. */
  viewMode: DiffViewMode;
  /** Diff rendering mode. */
  renderMode: DiffRenderMode;
  /** Whether long lines wrap instead of scrolling horizontally. */
  lineWrap: boolean;
  /** Turn snapshots keyed by thread ID. */
  snapshotsByThread: Record<string, TurnSnapshot[]>;
  /** Whether snapshots are currently loading, keyed by thread ID. */
  snapshotsLoadingByThread: Record<string, boolean>;
  /** Git commits keyed by thread ID. */
  commitsByThread: Record<string, GitCommit[]>;
  /** Whether commits are currently loading, keyed by thread ID. */
  commitsLoadingByThread: Record<string, boolean>;
  /**
   * Inline diff cache keyed by `"threadId:source:id:filePath"`. Survives
   * component unmounts (panel close/reopen, tab switches) so diffs aren't
   * re-fetched. Scoped by thread to prevent cross-thread collisions.
   */
  inlineDiffCache: Record<string, string>;
  /** Currently selected file for diff viewing. */
  selectedFile: SelectedFile | null;
  /** Raw unified diff text for the selected file. */
  diffContent: string | null;
  /** Whether diff content is currently loading. */
  diffLoading: boolean;
  /** Persisted diff summary for the current thread. */
  summaryRecord: {
    id: string;
    threadId: string;
    content: string;
    turnCount: number;
    lastTurnId: string | null;
    model: string;
    createdAt: string;
  } | null;
  /** Whether a summary is currently being generated. */
  summaryLoading: boolean;
  getRightPanel: (threadId: string) => RightPanelState;
  toggleRightPanel: (threadId: string) => void;
  showRightPanel: (threadId: string) => void;
  hideRightPanel: (threadId: string) => void;
  setRightPanelWidth: (threadId: string, width: number) => void;
  setRightPanelTab: (threadId: string, tab: RightPanelTab) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  toggleLineWrap: () => void;
  setSnapshots: (threadId: string, snapshots: TurnSnapshot[]) => void;
  setSnapshotsLoading: (threadId: string, loading: boolean) => void;
  setCommits: (threadId: string, commits: GitCommit[]) => void;
  setCommitsLoading: (threadId: string, loading: boolean) => void;
  selectFile: (file: SelectedFile | null) => void;
  setDiffContent: (content: string | null) => void;
  setDiffLoading: (loading: boolean) => void;
  /** Set the loaded summary record. */
  setSummaryRecord: (record: DiffState["summaryRecord"]) => void;
  /** Set summary loading state. */
  setSummaryLoading: (loading: boolean) => void;
  /** Cache a fetched inline diff so it survives component unmounts. */
  cacheInlineDiff: (threadId: string, source: string, id: string, filePath: string, data: string) => void;
  /** Retrieve a cached inline diff, or undefined if not cached. */
  getCachedInlineDiff: (threadId: string, source: string, id: string, filePath: string) => string | undefined;
  /** Persist the omnibox URL for a thread's embedded preview. */
  setPreviewUrlForThread: (threadId: string, url: string) => void;
  clearThread: (threadId: string) => void;
}

/** Zustand store for diff panel and right panel tab state. */
export const useDiffStore = create<DiffState>((set, get) => ({
  previewUrlByThread: {},
  rightPanelByThread: {},
  viewMode: "by-turn",
  renderMode: "unified",
  lineWrap: false,
  snapshotsByThread: {},
  snapshotsLoadingByThread: {},
  commitsByThread: {},
  commitsLoadingByThread: {},
  inlineDiffCache: {},
  selectedFile: null,
  diffContent: null,
  diffLoading: false,
  summaryRecord: null,
  summaryLoading: false,

  getRightPanel: (threadId) =>
    get().rightPanelByThread[threadId] ?? createDefaultRightPanelState(),

  toggleRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? createDefaultRightPanelState();
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: !current.visible },
        },
      };
    }),

  showRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? createDefaultRightPanelState();
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: true },
        },
      };
    }),

  hideRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? createDefaultRightPanelState();
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: false },
        },
      };
    }),

  setRightPanelWidth: (threadId, width) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? createDefaultRightPanelState();
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, width: clampWidth(width) },
        },
      };
    }),

  setRightPanelTab: (threadId, tab) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? createDefaultRightPanelState();
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, activeTab: tab },
        },
      };
    }),

  setViewMode: (mode) => set({ viewMode: mode, selectedFile: null, diffContent: null }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  toggleLineWrap: () => set((s) => ({ lineWrap: !s.lineWrap })),
  setSnapshots: (threadId, snapshots) =>
    set((s) => ({ snapshotsByThread: { ...s.snapshotsByThread, [threadId]: snapshots } })),
  setSnapshotsLoading: (threadId, loading) =>
    set((s) => ({ snapshotsLoadingByThread: { ...s.snapshotsLoadingByThread, [threadId]: loading } })),
  setCommits: (threadId, commits) =>
    set((s) => ({ commitsByThread: { ...s.commitsByThread, [threadId]: commits } })),
  setCommitsLoading: (threadId, loading) =>
    set((s) => ({ commitsLoadingByThread: { ...s.commitsLoadingByThread, [threadId]: loading } })),
  selectFile: (file) => set({ selectedFile: file, diffContent: null, diffLoading: false }),
  setDiffContent: (content) => set({ diffContent: content, diffLoading: false }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  setSummaryRecord: (record) => set({ summaryRecord: record }),
  setSummaryLoading: (loading) => set({ summaryLoading: loading }),
  cacheInlineDiff: (threadId, source, id, filePath, data) =>
    set((s) => ({
      inlineDiffCache: { ...s.inlineDiffCache, [`${threadId}:${source}:${id}:${filePath}`]: data },
    })),
  getCachedInlineDiff: (threadId, source, id, filePath) =>
    get().inlineDiffCache[`${threadId}:${source}:${id}:${filePath}`],
  setPreviewUrlForThread: (threadId, url) =>
    set((s) => ({
      previewUrlByThread: { ...s.previewUrlByThread, [threadId]: url },
    })),
  clearThread: (threadId) =>
    set((state) => {
      const snapshots = { ...state.snapshotsByThread };
      delete snapshots[threadId];
      const snapshotsLoading = { ...state.snapshotsLoadingByThread };
      delete snapshotsLoading[threadId];
      const commits = { ...state.commitsByThread };
      delete commits[threadId];
      const commitsLoading = { ...state.commitsLoadingByThread };
      delete commitsLoading[threadId];
      const rightPanels = { ...state.rightPanelByThread };
      delete rightPanels[threadId];
      const previewUrls = { ...state.previewUrlByThread };
      delete previewUrls[threadId];

      // Evict inline diff cache entries scoped to this thread.
      const prefix = `${threadId}:`;
      const inlineDiffCache: Record<string, string> = {};
      for (const [key, value] of Object.entries(state.inlineDiffCache)) {
        if (!key.startsWith(prefix)) inlineDiffCache[key] = value;
      }

      // Only clear the global selection when it belongs to the deleted thread.
      const selectionBelongsToThread = state.selectedFile?.threadId === threadId;
      const summaryBelongsToThread = state.summaryRecord?.threadId === threadId;

      return {
        snapshotsByThread: snapshots,
        snapshotsLoadingByThread: snapshotsLoading,
        commitsByThread: commits,
        commitsLoadingByThread: commitsLoading,
        rightPanelByThread: rightPanels,
        previewUrlByThread: previewUrls,
        inlineDiffCache,
        ...(selectionBelongsToThread
          ? { selectedFile: null, diffContent: null, diffLoading: false }
          : {}),
        ...(summaryBelongsToThread
          ? { summaryRecord: null, summaryLoading: false }
          : {}),
      };
    }),
}));
