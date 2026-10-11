import { create } from "zustand";
import type { TurnSnapshot, BranchComparison, ReviewTurn } from "@mcode/contracts";
import { defaultReviewView, type ReviewChangeState } from "@/lib/review-views";

export type { BranchComparison };

/**
 * One right-panel tool. The rail lists each open tool once; tools that hold
 * several items (Terminal records, Browser pages) show them as row-1 tabs
 * inside the tool. See ADR-0025.
 */
export type RightPanelTool =
  | "preview"
  | "terminal"
  | "changes"
  | "environment"
  | "tasks"
  | "subagents"
  | "coordination";

const RIGHT_PANEL_TOOLS: ReadonlySet<string> = new Set<RightPanelTool>([
  "preview",
  "terminal",
  "changes",
  "environment",
  "tasks",
  "subagents",
  "coordination",
]);

function isRightPanelTool(value: string): value is RightPanelTool {
  return RIGHT_PANEL_TOOLS.has(value);
}

/** Selected roster view within a thread's Subagents panel. */
export type SubagentRosterTab = "active" | "finished";

/** Navigation state for one thread's Subagents detail view. */
export interface SubagentDetailSelection {
  readonly id: string;
  /** Canonical roster tab, unresolved for selections opened from narration. */
  readonly originTab?: SubagentRosterTab;
  readonly scrollTop: number;
}

/**
 * View mode within the Review (Changes) tab. The tab is dual-scope: the first
 * four are threadless git working-tree views (read the workspace root); the last
 * three are thread turn views. Each renders exactly one diff. See
 * {@link import("@/lib/review-views").REVIEW_VIEWS} for the selection model.
 */
export type DiffViewMode =
  | "unstaged"
  | "staged"
  | "commit"
  | "branch"
  | "last-turn"
  | "turn"
  | "cumulative";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 384;
/**
 * Minimum width reserved for the chat/composer beside an inline right panel.
 * Drag and resize clamping use this (not {@link PANEL_MIN_WIDTH}) so the panel
 * cannot swallow the project tree and still crush the composer to one column.
 */
export const COMPOSER_MIN_WIDTH = 480;
/** Gap between chat main and right panel in App.tsx. The visible split is a draggable line. */
export const PANEL_SPLIT_GAP_PX = 0;
/**
 * The panel's default width — a fixed value, not a fraction of the viewport, so
 * the panel opens at the same size on every startup, on every view, regardless of
 * monitor width. Half-the-viewport defaults made the empty/startup panel balloon
 * (e.g. 800px on a 1600px screen) and tip into the cramped-chat overlay; a fixed
 * default keeps it consistent and inline.
 */
export const PANEL_DEFAULT_WIDTH = 440;
/** Wide snap target for the right panel (double-click drag handle). */
export const PANEL_WIDE_WIDTH = 680;
const REVIEW_FILES_VISIBILITY_STORAGE_KEY = "mcode.review-files-visible.v1";

function readReviewFilesVisibility(): Record<string, boolean> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(REVIEW_FILES_VISIBILITY_STORAGE_KEY);
    if (!raw || raw.length > 100_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 1_000)
        .filter(([key, visible]) => key.length > 0 && key.length <= 4_096 && typeof visible === "boolean"),
    );
  } catch {
    return {};
  }
}

function writeReviewFilesVisibility(value: Record<string, boolean>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(REVIEW_FILES_VISIBILITY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Visibility still updates for this session when browser persistence is unavailable.
  }
}

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, w);
}

/**
 * Returns the panel's default width ({@link PANEL_DEFAULT_WIDTH}, clamped to
 * {@link PANEL_MIN_WIDTH}). A fixed default keeps the startup size consistent
 * across views and monitors. Used when a workspace has no stored width yet.
 */
export function getDefaultPanelWidthPx(): number {
  return clampWidth(PANEL_DEFAULT_WIDTH);
}

/**
 * Largest panel width that still leaves {@link COMPOSER_MIN_WIDTH}px for the
 * composer in a split row of the given inner width (chat + gap + panel).
 */
export function maxPanelWidthInSplit(
  splitWidthPx: number,
  gapPx: number = PANEL_SPLIT_GAP_PX,
): number {
  return Math.max(PANEL_MIN_WIDTH, splitWidthPx - COMPOSER_MIN_WIDTH - gapPx);
}

/** Review comparison source that decides how a file's diff is fetched and cached. */
export type DiffSource = "snapshot" | "turn-diff" | "cumulative" | "commit" | "unstaged" | "staged" | "branch";

/**
 * Right panel container state (visibility, width, open tabs, active tab). Stored
 * per thread, with one workspace-level fallback for the threadless and
 * not-yet-customized cases (ADR-0012).
 */
export type RightPanelState = {
  readonly visible: boolean;
  readonly width: number;
  /** Whether width came from adaptive auto-open sizing or an explicit user resize. */
  readonly widthSource?: "auto" | "user";
  /**
   * The singleton tab types the user has opened, in open order. Empty means no
   * tab is open and the panel shows the card-grid empty state (ADR-0004). Tab
   * types are opened on demand rather than always present.
   */
  readonly openTabs: readonly RightPanelTool[];
  readonly activeTab: RightPanelTool;
  /** Ordered open tools, one instance per tool. */
  readonly tabInstances: readonly RightPanelTabInstance[];
  /** Stable identity of the active tool instance. */
  readonly activeTabId: string | null;
};

/** One open right-panel tool. Every tool is a singleton with a deterministic id. */
export type RightPanelTabInstance = {
  [T in RightPanelTool]: { readonly id: `singleton:${T}`; readonly type: T };
}[RightPanelTool];

/** Stable identity for an open tool. */
export function rightPanelSingletonId<T extends RightPanelTool>(type: T): `singleton:${T}` {
  return `singleton:${type}`;
}

/** The rail instance for one tool. */
export function rightPanelToolInstance(type: RightPanelTool): RightPanelTabInstance {
  // The mapped union cannot narrow a generic `type`, so each member is spelled out.
  switch (type) {
    case "preview": return { id: "singleton:preview", type };
    case "terminal": return { id: "singleton:terminal", type };
    case "changes": return { id: "singleton:changes", type };
    case "environment": return { id: "singleton:environment", type };
    case "tasks": return { id: "singleton:tasks", type };
    case "subagents": return { id: "singleton:subagents", type };
    case "coordination": return { id: "singleton:coordination", type };
  }
}

/** Resolve ordered instances from current or legacy in-memory panel state. */
export function rightPanelTabInstances(
  state: Pick<RightPanelState, "openTabs"> & Partial<Pick<RightPanelState, "tabInstances">>,
): readonly RightPanelTabInstance[] {
  return state.tabInstances ?? state.openTabs.map(rightPanelToolInstance);
}

/** Resolve the active tool type from canonical instance state. */
export function rightPanelActiveTab(state: RightPanelState): RightPanelTool {
  return (
    state.tabInstances.find((instance) => instance.id === state.activeTabId)?.type ??
    "tasks"
  );
}

/** Tab instance shape accepted from older in-memory panel records. */
export type LegacyRightPanelTabInstance = { readonly id: string; readonly type: string };

/** Shell rail tabs used type `terminal`; Project Action rail tabs used `action-terminal`. */
const LEGACY_TERMINAL_TYPE = /^(?:action-)?terminal$/;

/**
 * Collapses older per-terminal rail instances (`terminal:<ptyId>`,
 * `action-terminal:<actionId>`) into one Terminal tool at the first one's
 * position and drops unknown tool types. An active legacy terminal instance
 * becomes the active Terminal tool. Returns the inputs unchanged when they are
 * already canonical. See ADR-0025.
 */
export function normalizeRightPanelTabInstances(
  instances: readonly LegacyRightPanelTabInstance[],
  activeTabId: string | null,
): { readonly tabInstances: readonly RightPanelTabInstance[]; readonly activeTabId: string | null } {
  // Keep the array identity for canonical state so memoized readers stay stable.
  if (instances.every(isCanonicalInstance) && new Set(instances.map((i) => i.type)).size === instances.length) {
    return { tabInstances: instances, activeTabId };
  }
  const tabInstances: RightPanelTabInstance[] = [];
  const seen = new Set<RightPanelTool>();
  let nextActiveTabId: string | null = null;
  for (const instance of instances) {
    const type = LEGACY_TERMINAL_TYPE.test(instance.type) ? "terminal" : instance.type;
    if (!isRightPanelTool(type)) continue;
    const canonical = rightPanelToolInstance(type);
    if (instance.id === activeTabId) nextActiveTabId = canonical.id;
    if (seen.has(type)) continue;
    seen.add(type);
    tabInstances.push(canonical);
  }
  return { tabInstances, activeTabId: nextActiveTabId };
}

function isCanonicalInstance(instance: LegacyRightPanelTabInstance): instance is RightPanelTabInstance {
  return isRightPanelTool(instance.type) && instance.id === rightPanelSingletonId(instance.type);
}

type RightPanelStateInput = Omit<
  RightPanelState,
  "openTabs" | "activeTab" | "tabInstances" | "activeTabId"
> & {
  readonly openTabs?: readonly RightPanelTool[];
  readonly activeTab?: RightPanelTool;
  readonly tabInstances?: readonly LegacyRightPanelTabInstance[];
  readonly activeTabId?: string | null;
};

/** Build panel state whose compatibility fields are derived from canonical instances. */
export function createRightPanelState(input: RightPanelStateInput): RightPanelState {
  const rawInstances: readonly LegacyRightPanelTabInstance[] =
    input.tabInstances ?? (input.openTabs ?? []).map(rightPanelToolInstance);
  const rawActiveTabId = Object.prototype.hasOwnProperty.call(input, "activeTabId")
    ? input.activeTabId ?? null
    : rawInstances.find((instance) => instance.type === input.activeTab)?.id ?? null;
  const { tabInstances, activeTabId } = normalizeRightPanelTabInstances(rawInstances, rawActiveTabId);
  const state = {
    ...input,
    tabInstances,
    activeTabId,
  } as RightPanelState;
  Object.defineProperties(state, {
    openTabs: {
      enumerable: true,
      get: () => state.tabInstances.map((instance) => instance.type),
    },
    activeTab: {
      enumerable: true,
      get: () => rightPanelActiveTab(state),
    },
  });
  return state;
}

/** Default line-wrap preference for a thread with no stored override. */
export const DEFAULT_LINE_WRAP = true;

/**
 * Baseline right-panel state used when neither the thread nor its workspace
 * fallback has a stored record yet (default width, closed, no open tabs).
 */
export function createDefaultRightPanelState(): RightPanelState {
  return createRightPanelState({
    visible: false,
    width: getDefaultPanelWidthPx(),
    widthSource: "auto",
    tabInstances: [],
    activeTabId: null,
  });
}

/**
 * Stable cache key for one inline diff payload. `cacheVersion` sits between
 * the id and path so a response fetched under an older revision can never be
 * read back under a newer one, while every existing `scopeId:` prefix eviction
 * still matches.
 */
export function inlineDiffCacheKey(
  threadId: string,
  source: string,
  id: string,
  filePath: string,
  cacheVersion: string | number,
): string {
  return `${threadId}:${source}:${id}:${cacheVersion}:${filePath}`;
}

/** Drop inline diff cache entries matching a stable key prefix. */
function omitInlineDiffCacheByPrefix(
  cache: Record<string, string>,
  prefix: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }
  return next;
}

/** Copy a record, dropping entries whose key ends with `suffix`. */
function omitByKeySuffix<V>(record: Record<string, V>, suffix: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith(suffix)) next[key] = value;
  }
  return next;
}

/** Copy a record, dropping entries whose key starts with `prefix`. */
function omitByKeyPrefix<V>(record: Record<string, V>, prefix: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }
  return next;
}

/** Remove the workspace-scoped Terminal tool before seeding a thread panel. */
function withoutTerminalTool(state: RightPanelState): RightPanelState {
  const instances = rightPanelTabInstances(state);
  const activeTerminalIndex = instances.findIndex(
    (instance) => instance.id === state.activeTabId && instance.type === "terminal",
  );
  const tabInstances = instances.filter((instance) => instance.type !== "terminal");
  if (activeTerminalIndex < 0) {
    return createRightPanelState({ ...state, tabInstances });
  }

  // Match close-tab focus: select the nearest surviving item to the right of
  // the removed tab, then the nearest surviving item on its left.
  const nextActive =
    instances.slice(activeTerminalIndex + 1).find((instance) => instance.type !== "terminal") ??
    instances.slice(0, activeTerminalIndex)
      .reverse()
      .find((instance) => instance.type !== "terminal") ??
    null;
  return createRightPanelState({
    ...state,
    tabInstances,
    activeTabId: nextActive?.id ?? null,
  });
}

/**
 * Projects the raw panel records for one scope without leaking the workspace
 * Terminal tool into an untouched thread, whose terminal records differ. Thread-owned records remain
 * unchanged; inherited fallback state keeps visibility, width, and all
 * non-Terminal tab state. See ADR-0012 and ADR-0025.
 */
export function projectRightPanelForScope(
  ownedPanel: RightPanelState | undefined,
  fallbackPanel: RightPanelState | undefined,
  threadId: string | null | undefined,
): RightPanelState {
  const panel = ownedPanel ?? fallbackPanel;
  if (!panel) return createDefaultRightPanelState();
  const resolved = createRightPanelState(panel);
  return threadId && !ownedPanel ? withoutTerminalTool(resolved) : resolved;
}

/**
 * Resolves the effective panel record for a scope (ADR-0012 copy-on-write read).
 * A thread with its own record uses it; otherwise it falls through to the
 * workspace fallback, which also serves the threadless shell. Thread reads
 * omit the workspace-scoped Terminal tool before applying that fallback.
 * Defaults when neither exists yet.
 */
function effectiveRightPanel(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
): RightPanelState {
  return projectRightPanelForScope(
    threadId ? state.rightPanelByThread[threadId] : undefined,
    state.rightPanelFallbackByWorkspace[workspaceId],
    threadId,
  );
}

/**
 * Computes the next state slice that writes `next` to a scope's panel record. A
 * thread writes (and so diverges into) its own per-thread record; without a
 * thread, the write lands on the workspace fallback. This is the copy-on-write
 * write path that pairs with {@link effectiveRightPanel}.
 */
function writeRightPanel(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
  next: RightPanelState,
): Partial<DiffState> {
  if (threadId) {
    return {
      rightPanelByThread: {
        ...state.rightPanelByThread,
        [threadId]: createRightPanelState(next),
      },
    };
  }
  return {
    rightPanelFallbackByWorkspace: {
      ...state.rightPanelFallbackByWorkspace,
      [workspaceId]: createRightPanelState(next),
    },
  };
}

/**
 * Computes the next state slice for a panel visibility change. Reads the scope's
 * effective record and writes it back through copy-on-write. Pass `next` to set
 * an explicit value, or `undefined` to toggle the current effective value.
 */
function setPanelVisible(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
  next: boolean | undefined,
): Partial<DiffState> {
  const current = effectiveRightPanel(state, workspaceId, threadId);
  return writeRightPanel(state, workspaceId, threadId, {
    ...current,
    visible: next ?? !current.visible,
  });
}

/**
 * Static defaults for workspaces with no panel store row; live width uses
 * {@link getDefaultPanelWidthPx} through {@link createDefaultRightPanelState}.
 */
export const RIGHT_PANEL_DEFAULTS: RightPanelState = createRightPanelState({
  visible: false,
  width: PANEL_DEFAULT_WIDTH,
  widthSource: "auto",
  tabInstances: [],
  activeTabId: null,
});

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Last preview URL typed or loaded per thread (in-memory only). */
  readonly previewUrlByThread: Record<string, string>;
  /**
   * Per-thread right panel container state keyed by thread ID — the full record
   * (visibility, width, open tabs, active tab). A thread has no entry until it
   * writes one (copy-on-write divergence from the workspace fallback), after
   * which its own record is authoritative. Dropped by {@link clearThread}. Tab
   * *contents* keep their own (thread or workspace-root) scope; see ADR-0012.
   */
  readonly rightPanelByThread: Record<string, RightPanelState>;
  /**
   * One workspace-level fallback panel record keyed by workspace ID. Serves the
   * threadless Browser/Terminal shell and seeds a not-yet-customized thread's
   * scope-neutral state (visibility, width, and non-Terminal tabs) until that
   * thread diverges into its own {@link rightPanelByThread} entry. See ADR-0012
   * and ADR-0025.
   */
  readonly rightPanelFallbackByWorkspace: Record<string, RightPanelState>;
  /**
   * The remembered Subagents roster view for each thread. This inner-panel state
   * survives right-panel unmounts but is intentionally dropped with its thread.
   */
  readonly subagentRosterTabByThread: Record<string, SubagentRosterTab>;
  /** Selected Subagents detail and roster return position for each thread. */
  readonly subagentDetailByThread: Record<string, SubagentDetailSelection>;
  /** Explicit Files visibility choices keyed by Review scope. Missing scopes start closed. */
  readonly reviewFilesVisibleByScope: Record<string, boolean>;
  /** View mode within the Changes tab (the single rendered view). */
  viewMode: DiffViewMode;
  /**
   * Per-thread remembered Review view, keyed by thread ID. Written when the user
   * picks a view for a thread; read back to restore that pick when returning to
   * the thread. In-memory only; dropped by {@link clearThread}. See ADR-0011.
   */
  readonly reviewViewByThread: Record<string, DiffViewMode>;
  /**
   * Per-thread "the user picked a view" override flag, keyed by thread ID. While
   * unset, the Review default re-evaluates live from the thread's change state;
   * once set, the pick sticks and auto-defaulting stops for that thread. See
   * ADR-0011.
   */
  readonly reviewViewManuallySelectedByThread: Record<string, boolean>;
  /**
   * The Turn view's picked operand, keyed by thread ID: the assistant message ID
   * owning the turn whose diff renders. Persists across view switches so picking
   * Turn again returns to the same turn. In-memory only; dropped by
   * {@link clearThread}.
   */
  readonly selectedTurnMessageIdByThread: Record<string, string>;
  /**
   * The Branch view's current→selected comparison for the current scope, or null
   * until the picker resolves it. Drives both the ref picker and the rendered
   * Branch diff. See
   * `docs/adr/0007-branch-comparison-default-and-range.md`.
   */
  branchComparison: BranchComparison | null;
  /**
   * The scope key (`workspaceId:threadId`) {@link branchComparison} was resolved
   * for. Lets the picker re-resolve on a scope change while preserving a user's
   * picked comparison ref when toggling views within the same scope.
   */
  branchComparisonKey: string | null;
  /**
   * Per-scope "the user manually picked a Branch comparison operand" flag, keyed
   * by the same `workspaceId:threadId` scope as {@link branchComparisonKey}. While
   * set, re-resolution preserves the user's picked ref (when it still exists)
   * instead of reverting to the server default - so a turn-driven `diffRevision`
   * bump or a picker remount no longer clobbers the selection. Mirrors
   * `reviewViewManuallySelectedByThread` (ADR-0011).
   */
  branchManuallySelectedByScope: Record<string, boolean>;
  /**
   * The `diffRevision` each scope's {@link branchComparison} was last resolved at,
   * keyed by scope. Store-backed (not a component ref) so the "already resolved for
   * this scope+revision" guard survives a picker remount and skips a redundant
   * re-fetch.
   */
  branchResolvedRevisionByScope: Record<string, number>;
  /**
   * The commit the Commit view's picker has resolved to, by SHA. `null` means
   * the picker has not resolved the current scope yet, or the scope has no
   * commits. This is the Commit comparison's picked operand: the Review toolbar's
   * commit picker writes it, and the Commit diff reads it to render exactly that
   * one commit. Reset when the active view changes so a stale pick never bleeds
   * into the next Commit view.
   */
  selectedCommitSha: string | null;
  /** Diff rendering mode. */
  renderMode: DiffRenderMode;
  /** Changed-file count for the active Review view, shown as a toolbar badge. Null when unknown. */
  reviewFileCount: number | null;
  /** Total added/removed lines for the active Review view. Null while loading or unknown. */
  reviewDiffStat: { additions: number; deletions: number } | null;
  /** Bulk expand/collapse command for the Review view's file cards; each FileEntry applies it on nonce change. */
  bulkDiffExpand: { expand: boolean; nonce: number } | null;
  /** File-tree jump request for the active Review scope. `viewKey` pins the request to the view it was issued for (e.g. `turn:<messageId>`), so an outgoing view's list cannot consume a request meant for the incoming one. */
  reviewFileJumpRequest: { scopeId: string; path: string; nonce: number; viewKey?: string } | null;
  /** Per-thread line-wrap preference keyed by thread ID. */
  readonly lineWrapByThread: Record<string, boolean>;
  /** Turn snapshots keyed by thread ID. */
  snapshotsByThread: Record<string, TurnSnapshot[]>;
  /** Whether snapshots are currently loading, keyed by thread ID. */
  snapshotsLoadingByThread: Record<string, boolean>;
  /** Server-ordered Review turns keyed by thread ID; ordinals survive snapshot expiry. */
  reviewTurnsByThread: Record<string, ReviewTurn[]>;
  /** Why the last turn-list request failed, keyed by thread ID; cleared when a list arrives. */
  reviewTurnsErrorByThread: Record<string, string>;
  /** Whether the Review view menu is open; state bodies open it to offer another view. */
  reviewViewMenuOpen: boolean;
  /**
   * Inline diff cache keyed by `"threadId:source:id:version:filePath"`. Survives
   * component unmounts (panel close/reopen, tab switches) so diffs aren't
   * re-fetched. Scoped by thread to prevent cross-thread collisions.
   */
  inlineDiffCache: Record<string, string>;
  /**
   * Monotonic revision by diff scope (thread id or workspace id). Mutable git
   * views use this to refetch when a turn or filesystem event changes the
   * checkout without changing the visible ref names.
   */
  diffRevisionByScope: Record<string, number>;
  /**
   * Effective panel record for a scope: the thread's own record when it has
   * diverged, otherwise the workspace fallback (ADR-0012 copy-on-write read).
   */
  getRightPanel: (workspaceId: string, threadId?: string | null) => RightPanelState;
  /** Effective open/closed state for the panel scope ({@link getRightPanel}). */
  getRightPanelVisible: (workspaceId: string, threadId?: string | null) => boolean;
  /** Toggle the panel for a thread (per-thread) or the threadless shell (workspace). */
  toggleRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Open the panel for a thread (per-thread) or the threadless shell (workspace). */
  showRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Close the panel for a thread (per-thread) or the threadless shell (workspace). */
  hideRightPanel: (workspaceId: string, threadId?: string | null) => void;
  setRightPanelWidth: (
    workspaceId: string,
    threadId: string | null | undefined,
    width: number,
    source?: "auto" | "user" | "preserve",
  ) => void;
  setRightPanelTab: (workspaceId: string, threadId: string | null | undefined, tab: RightPanelTool) => void;
  setRightPanelTabInstance: (
    workspaceId: string,
    threadId: string | null | undefined,
    instanceId: string,
  ) => void;
  /** Open a tool without changing the active tool or panel visibility. No-op when it is open. */
  ensureRightPanelTab: (
    workspaceId: string,
    threadId: string | null | undefined,
    tab: RightPanelTool,
  ) => void;
  /** Move one tab instance by one bounded position in its scope. */
  reorderRightPanelTab: (
    workspaceId: string,
    threadId: string | null | undefined,
    instanceId: string,
    direction: -1 | 1,
  ) => void;
  /** Close one tab by stable instance identity. */
  closeRightPanelTabInstance: (
    workspaceId: string,
    threadId: string | null | undefined,
    instanceId: string,
  ) => void;
  /**
   * Close (remove) a singleton tab from the open set. When the closed tab was
   * active, focus falls back to the most-recently-opened remaining tab; with
   * none left the panel returns to the card-grid empty state. No-op when the tab
   * is not open. See ADR-0004.
   */
  closeRightPanelTab: (workspaceId: string, threadId: string | null | undefined, tab: RightPanelTool) => void;
  /** Close every tab and hide one right-panel scope while preserving its width. */
  clearRightPanel: (workspaceId: string, threadId: string | null | undefined) => void;
  /** Read a thread's remembered Subagents roster view, if it has one. */
  getSubagentRosterTab: (threadId: string) => SubagentRosterTab | undefined;
  /** Remember the selected Subagents roster view for one thread. */
  setSubagentRosterTab: (threadId: string, tab: SubagentRosterTab) => void;
  /** Open a thread-scoped Subagents detail. */
  selectSubagentDetail: (threadId: string, selection: SubagentDetailSelection) => void;
  /** Return one thread to its Subagents roster. */
  clearSubagentDetail: (threadId: string) => void;
  /** Read the persisted Files visibility choice for a Review scope. */
  getReviewFilesVisible: (scopeId: string) => boolean;
  /** Persist an explicit Files visibility choice for a Review scope. */
  setReviewFilesVisible: (scopeId: string, visible: boolean) => void;
  setViewMode: (mode: DiffViewMode) => void;
  /**
   * Resolve the Review view a thread should show: the user's sticky pick when
   * they have chosen one, otherwise the change-state default (re-evaluated live
   * from `changeState`). See ADR-0011.
   */
  getReviewView: (threadId: string, changeState: ReviewChangeState) => DiffViewMode;
  /**
   * Record a manual Review view pick for a thread: stores the view, sets the
   * sticky per-thread override, and makes it the rendered view. Stops live
   * auto-defaulting for that thread. See ADR-0011.
   */
  setReviewViewForThread: (threadId: string, mode: DiffViewMode) => void;
  /**
   * Record the Turn view's picked operand for a thread: the assistant message ID
   * whose settled turn diff renders. Written by the per-turn change summary's
   * diff entry points.
   */
  setReviewTurnForThread: (threadId: string, messageId: string) => void;
  /**
   * Apply a freshly resolved Branch comparison for a scope, recording the revision
   * it was resolved at and preserving the user's manually picked target when that
   * scope is flagged and the picked ref still exists.
   */
  resolveBranchComparison: (
    comparison: BranchComparison,
    key: string,
    revision: number,
  ) => void;
  /** Override the base ref of the active Branch comparison (no-op if none resolved). */
  setBranchBase: (ref: string) => void;
  /** Override the target ref of the active Branch comparison (no-op if none resolved). */
  setBranchTarget: (ref: string) => void;
  /** Set the Commit view's picked operand by SHA, or `null` to fall back to the latest commit. */
  setSelectedCommitSha: (sha: string | null) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  /** Report the active Review view's changed-file count (set by FileList). */
  setReviewFileCount: (count: number | null) => void;
  /** Report the active Review view's total added/removed lines (set by the view). */
  setReviewDiffStat: (stat: { additions: number; deletions: number } | null) => void;
  /** Expand or collapse every file card in the active Review view. */
  setBulkDiffExpand: (expand: boolean) => void;
  /** Ask the active Review file list to reveal one changed file. `viewKey` pins the request to the issuing view (e.g. `turn:<messageId>`); omit for requests any view in the scope may serve. */
  requestReviewFileJump: (scopeId: string, path: string, viewKey?: string) => void;
  /** Drop a consumed or stale Review file-jump request. */
  clearReviewFileJump: () => void;
  getLineWrap: (threadId: string) => boolean;
  toggleLineWrap: (threadId: string) => void;
  setSnapshots: (threadId: string, snapshots: TurnSnapshot[]) => void;
  setSnapshotsLoading: (threadId: string, loading: boolean) => void;
  /** Store the server's turn list for a thread. */
  setReviewTurns: (threadId: string, turns: ReviewTurn[]) => void;
  /** Record that the thread's turn list could not be loaded, or clear it with null when a new request starts. */
  setReviewTurnsError: (threadId: string, detail: string | null) => void;
  /** Open or close the Review view menu. */
  setReviewViewMenuOpen: (open: boolean) => void;
  /** Cache a fetched inline diff so it survives component unmounts. */
  cacheInlineDiff: (threadId: string, source: string, id: string, filePath: string, data: string, cacheVersion: string | number) => void;
  /** Retrieve a cached inline diff, or undefined if not cached. */
  getCachedInlineDiff: (threadId: string, source: string, id: string, filePath: string, cacheVersion: string | number) => string | undefined;
  /** Bump a mutable diff scope so mounted file rows refetch against the latest checkout. */
  bumpDiffRevision: (scopeId: string) => void;
  /** Persist the omnibox URL for a thread's embedded preview. */
  setPreviewUrlForThread: (threadId: string, url: string) => void;
  clearThread: (threadId: string) => void;
  /** Drop a workspace's persisted panel state (called on workspace deletion). */
  clearWorkspace: (workspaceId: string) => void;
}

/** Zustand store for diff panel and right panel tab state. */
export const useDiffStore = create<DiffState>((set, get) => ({
  previewUrlByThread: {},
  rightPanelByThread: {},
  rightPanelFallbackByWorkspace: {},
  subagentRosterTabByThread: {},
  subagentDetailByThread: {},
  reviewFilesVisibleByScope: readReviewFilesVisibility(),
  viewMode: "last-turn",
  reviewViewByThread: {},
  reviewViewManuallySelectedByThread: {},
  selectedTurnMessageIdByThread: {},
  branchComparison: null,
  branchComparisonKey: null,
  branchManuallySelectedByScope: {},
  branchResolvedRevisionByScope: {},
  selectedCommitSha: null,
  renderMode: "unified",
  reviewFileCount: null,
  reviewDiffStat: null,
  bulkDiffExpand: null,
  reviewFileJumpRequest: null,
  lineWrapByThread: {},
  snapshotsByThread: {},
  snapshotsLoadingByThread: {},
  reviewTurnsByThread: {},
  reviewTurnsErrorByThread: {},
  reviewViewMenuOpen: false,
  inlineDiffCache: {},
  diffRevisionByScope: {},

  getRightPanel: (workspaceId, threadId) =>
    effectiveRightPanel(get(), workspaceId, threadId),

  getRightPanelVisible: (workspaceId, threadId) =>
    effectiveRightPanel(get(), workspaceId, threadId).visible,

  toggleRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, undefined)),

  showRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, true)),

  hideRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, false)),

  setRightPanelWidth: (workspaceId, threadId, width, source = "user") =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      const nextWidth = clampWidth(width);
      const nextWidthSource = source === "preserve" ? current.widthSource : source;
      if (current.width === nextWidth && current.widthSource === nextWidthSource) return state;
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        width: nextWidth,
        widthSource: nextWidthSource,
      });
    }),

  setRightPanelTab: (workspaceId, threadId, tab) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      // Activating a tab opens it: tabs are singletons created on demand, so
      // focusing one that is not yet open adds it to the open set (the card grid
      // is the create surface). Already-open tabs are just refocused.
      const instanceId = rightPanelSingletonId(tab);
      const currentInstances = rightPanelTabInstances(current);
      const tabInstances = currentInstances.some((instance) => instance.id === instanceId)
        ? currentInstances
        : [...currentInstances, rightPanelToolInstance(tab)];
      const panelUpdate = writeRightPanel(state, workspaceId, threadId, {
        ...current,
        tabInstances,
        activeTabId: instanceId,
      });
      return panelUpdate;
    }),

  setRightPanelTabInstance: (workspaceId, threadId, instanceId) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      const instance = rightPanelTabInstances(current).find(
        (candidate) => candidate.id === instanceId,
      );
      if (!instance) return {};
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        activeTabId: instance.id,
      });
    }),

  ensureRightPanelTab: (workspaceId, threadId, tab) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      const currentInstances = rightPanelTabInstances(current);
      if (currentInstances.some((instance) => instance.type === tab)) return {};
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        tabInstances: [...currentInstances, rightPanelToolInstance(tab)],
      });
    }),

  reorderRightPanelTab: (workspaceId, threadId, instanceId, direction) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      const currentInstances = rightPanelTabInstances(current);
      const from = currentInstances.findIndex((instance) => instance.id === instanceId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= currentInstances.length) return {};
      const tabInstances = [...currentInstances];
      [tabInstances[from], tabInstances[to]] = [tabInstances[to], tabInstances[from]];
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        tabInstances,
      });
    }),

  closeRightPanelTabInstance: (workspaceId, threadId, instanceId) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      const currentInstances = rightPanelTabInstances(current);
      const removedIndex = currentInstances.findIndex(
        (instance) => instance.id === instanceId,
      );
      if (removedIndex < 0) return {};
      const tabInstances = currentInstances.filter(
        (instance) => instance.id !== instanceId,
      );
      const activeTabId = current.activeTabId;
      const nextActive =
        activeTabId === instanceId
          ? (tabInstances[removedIndex] ?? tabInstances[removedIndex - 1] ?? null)
          : null;
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        tabInstances,
        activeTabId: activeTabId === instanceId ? nextActive?.id ?? null : activeTabId,
        // Closing the last tab closes the panel; reopening lands on the empty state.
        visible: tabInstances.length > 0 && current.visible,
      });
    }),

  closeRightPanelTab: (workspaceId, threadId, tab) =>
    get().closeRightPanelTabInstance(workspaceId, threadId, rightPanelSingletonId(tab)),

  clearRightPanel: (workspaceId, threadId) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        visible: false,
        tabInstances: [],
        activeTabId: null,
      });
    }),

  getSubagentRosterTab: (threadId) => get().subagentRosterTabByThread[threadId],
  setSubagentRosterTab: (threadId, tab) =>
    set((state) =>
      state.subagentRosterTabByThread[threadId] === tab
        ? {}
        : { subagentRosterTabByThread: { ...state.subagentRosterTabByThread, [threadId]: tab } },
    ),
  selectSubagentDetail: (threadId, selection) =>
    set((state) => {
      const subagentRosterTabByThread = { ...state.subagentRosterTabByThread };
      if (selection.originTab === undefined) {
        delete subagentRosterTabByThread[threadId];
      } else {
        subagentRosterTabByThread[threadId] = selection.originTab;
      }
      return {
        subagentDetailByThread: { ...state.subagentDetailByThread, [threadId]: selection },
        subagentRosterTabByThread,
      };
    }),
  clearSubagentDetail: (threadId) =>
    set((state) => {
      if (!(threadId in state.subagentDetailByThread)) return {};
      const subagentDetailByThread = { ...state.subagentDetailByThread };
      delete subagentDetailByThread[threadId];
      return { subagentDetailByThread };
    }),
  getReviewFilesVisible: (scopeId) => get().reviewFilesVisibleByScope[scopeId] ?? false,
  setReviewFilesVisible: (scopeId, visible) =>
    set((state) => {
      const reviewFilesVisibleByScope = {
        ...state.reviewFilesVisibleByScope,
        [scopeId]: visible,
      };
      writeReviewFilesVisibility(reviewFilesVisibleByScope);
      return { reviewFilesVisibleByScope };
    }),

  setViewMode: (mode) =>
    set({ viewMode: mode, selectedCommitSha: null, reviewFileJumpRequest: null }),
  getReviewView: (threadId, changeState) => {
    const state = get();
    if (state.reviewViewManuallySelectedByThread[threadId]) {
      return state.reviewViewByThread[threadId] ?? defaultReviewView("thread", changeState);
    }
    return defaultReviewView("thread", changeState);
  },
  setReviewViewForThread: (threadId, mode) =>
    set((s) => ({
      viewMode: mode,
      reviewViewByThread: { ...s.reviewViewByThread, [threadId]: mode },
      reviewViewManuallySelectedByThread: {
        ...s.reviewViewManuallySelectedByThread,
        [threadId]: true,
      },
      selectedCommitSha: null,
      // A jump request belongs to the view it was issued for; a fresh pick
      // drops it so a stale path cannot fire in an unrelated view.
      reviewFileJumpRequest: null,
    })),
  setReviewTurnForThread: (threadId, messageId) =>
    set((s) => ({
      selectedTurnMessageIdByThread: {
        ...s.selectedTurnMessageIdByThread,
        [threadId]: messageId,
      },
    })),
  resolveBranchComparison: (comparison, key, revision) =>
    set((s) => {
      const sameScope = s.branchComparisonKey === key;
      const priorTarget = sameScope ? s.branchComparison?.target ?? null : null;
      // Preserve a manual pick across re-resolution, but only when the chosen ref
      // still exists in the freshly resolved set (a deleted branch must fall back).
      const keepTarget =
        s.branchManuallySelectedByScope[key] === true &&
        priorTarget !== null &&
        comparison.refs.some((ref) => ref.name === priorTarget);
      return {
        branchComparison: keepTarget
          ? { ...comparison, target: priorTarget }
          : comparison,
        branchComparisonKey: key,
        branchResolvedRevisionByScope: {
          ...s.branchResolvedRevisionByScope,
          [key]: revision,
        },
      };
    }),
  setBranchBase: (ref) =>
    set((s) =>
      s.branchComparison && s.branchComparisonKey
        ? {
            branchComparison: { ...s.branchComparison, base: ref },
            branchManuallySelectedByScope: {
              ...s.branchManuallySelectedByScope,
              [s.branchComparisonKey]: true,
            },
          }
        : {},
    ),
  setBranchTarget: (ref) =>
    set((s) =>
      s.branchComparison && s.branchComparisonKey
        ? {
            branchComparison: { ...s.branchComparison, target: ref },
            branchManuallySelectedByScope: {
              ...s.branchManuallySelectedByScope,
              [s.branchComparisonKey]: true,
            },
          }
        : {},
    ),
  setSelectedCommitSha: (sha) => set({ selectedCommitSha: sha }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  setReviewFileCount: (count) => set({ reviewFileCount: count }),
  setReviewDiffStat: (stat) => set({ reviewDiffStat: stat }),
  setBulkDiffExpand: (expand) =>
    set((s) => ({ bulkDiffExpand: { expand, nonce: (s.bulkDiffExpand?.nonce ?? 0) + 1 } })),
  requestReviewFileJump: (scopeId, path, viewKey) =>
    set((s) => ({
      reviewFileJumpRequest: {
        scopeId,
        path,
        viewKey,
        nonce: (s.reviewFileJumpRequest?.nonce ?? 0) + 1,
      },
    })),
  clearReviewFileJump: () => set({ reviewFileJumpRequest: null }),
  getLineWrap: (threadId) => get().lineWrapByThread[threadId] ?? DEFAULT_LINE_WRAP,
  toggleLineWrap: (threadId) =>
    set((state) => {
      const current = state.lineWrapByThread[threadId] ?? DEFAULT_LINE_WRAP;
      return {
        lineWrapByThread: {
          ...state.lineWrapByThread,
          [threadId]: !current,
        },
      };
    }),
  setSnapshots: (threadId, snapshots) =>
    set((s) => ({
      snapshotsByThread: { ...s.snapshotsByThread, [threadId]: snapshots },
      snapshotsLoadingByThread: { ...s.snapshotsLoadingByThread, [threadId]: false },
      inlineDiffCache: omitInlineDiffCacheByPrefix(
        s.inlineDiffCache,
        `${threadId}:cumulative:${threadId}:`,
      ),
    })),
  setSnapshotsLoading: (threadId, loading) =>
    set((s) => ({ snapshotsLoadingByThread: { ...s.snapshotsLoadingByThread, [threadId]: loading } })),
  setReviewTurns: (threadId, turns) =>
    set((s) => {
      const reviewTurnsErrorByThread = { ...s.reviewTurnsErrorByThread };
      delete reviewTurnsErrorByThread[threadId];
      return { reviewTurnsByThread: { ...s.reviewTurnsByThread, [threadId]: turns }, reviewTurnsErrorByThread };
    }),
  setReviewTurnsError: (threadId, detail) =>
    set((s) => {
      if (detail !== null) return { reviewTurnsErrorByThread: { ...s.reviewTurnsErrorByThread, [threadId]: detail } };
      if (!(threadId in s.reviewTurnsErrorByThread)) return s;
      const reviewTurnsErrorByThread = { ...s.reviewTurnsErrorByThread };
      delete reviewTurnsErrorByThread[threadId];
      return { reviewTurnsErrorByThread };
    }),
  setReviewViewMenuOpen: (open) => set({ reviewViewMenuOpen: open }),
  cacheInlineDiff: (threadId, source, id, filePath, data, cacheVersion) =>
    set((s) => ({
      inlineDiffCache: { ...s.inlineDiffCache, [inlineDiffCacheKey(threadId, source, id, filePath, cacheVersion)]: data },
    })),
  getCachedInlineDiff: (threadId, source, id, filePath, cacheVersion) =>
    get().inlineDiffCache[inlineDiffCacheKey(threadId, source, id, filePath, cacheVersion)],
  bumpDiffRevision: (scopeId) =>
    set((s) => ({
      diffRevisionByScope: {
        ...s.diffRevisionByScope,
        [scopeId]: (s.diffRevisionByScope[scopeId] ?? 0) + 1,
      },
      inlineDiffCache: omitInlineDiffCacheByPrefix(s.inlineDiffCache, `${scopeId}:`),
    })),
  setPreviewUrlForThread: (threadId, url) => {
    if (get().previewUrlByThread[threadId] === url) return;
    set((s) => ({
      previewUrlByThread: { ...s.previewUrlByThread, [threadId]: url },
    }));
  },
  clearThread: (threadId) =>
    set((state) => {
      const snapshots = { ...state.snapshotsByThread };
      delete snapshots[threadId];
      const snapshotsLoading = { ...state.snapshotsLoadingByThread };
      delete snapshotsLoading[threadId];
      const reviewTurns = { ...state.reviewTurnsByThread };
      delete reviewTurns[threadId];
      const reviewTurnsErrors = { ...state.reviewTurnsErrorByThread };
      delete reviewTurnsErrors[threadId];
      const previewUrls = { ...state.previewUrlByThread };
      delete previewUrls[threadId];
      const lineWrapByThread = { ...state.lineWrapByThread };
      delete lineWrapByThread[threadId];
      const rightPanelByThread = { ...state.rightPanelByThread };
      delete rightPanelByThread[threadId];
      const subagentRosterTabByThread = { ...state.subagentRosterTabByThread };
      delete subagentRosterTabByThread[threadId];
      const subagentDetailByThread = { ...state.subagentDetailByThread };
      delete subagentDetailByThread[threadId];
      const reviewViewByThread = { ...state.reviewViewByThread };
      delete reviewViewByThread[threadId];
      const reviewViewManuallySelectedByThread = { ...state.reviewViewManuallySelectedByThread };
      delete reviewViewManuallySelectedByThread[threadId];
      const selectedTurnMessageIdByThread = { ...state.selectedTurnMessageIdByThread };
      delete selectedTurnMessageIdByThread[threadId];
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[threadId];
      const reviewFilesVisibleByScope = { ...state.reviewFilesVisibleByScope };
      delete reviewFilesVisibleByScope[threadId];
      writeReviewFilesVisibility(reviewFilesVisibleByScope);
      const branchManuallySelectedByScope = omitByKeySuffix(
        state.branchManuallySelectedByScope,
        `:${threadId}`,
      );
      const branchResolvedRevisionByScope = omitByKeySuffix(
        state.branchResolvedRevisionByScope,
        `:${threadId}`,
      );

      const inlineDiffCache = omitInlineDiffCacheByPrefix(state.inlineDiffCache, `${threadId}:`);

      return {
        snapshotsByThread: snapshots,
        snapshotsLoadingByThread: snapshotsLoading,
        reviewTurnsByThread: reviewTurns,
        reviewTurnsErrorByThread: reviewTurnsErrors,
        previewUrlByThread: previewUrls,
        lineWrapByThread,
        rightPanelByThread,
        subagentRosterTabByThread,
        subagentDetailByThread,
        reviewViewByThread,
        reviewViewManuallySelectedByThread,
        selectedTurnMessageIdByThread,
        diffRevisionByScope,
        reviewFilesVisibleByScope,
        branchManuallySelectedByScope,
        branchResolvedRevisionByScope,
        inlineDiffCache,
      };
    }),
  clearWorkspace: (workspaceId) =>
    set((state) => {
      const cachePrefix = `${workspaceId}:`;
      const hasInlineDiffCache = Object.keys(state.inlineDiffCache).some((key) =>
        key.startsWith(cachePrefix),
      );
      const hasBranchScope =
        Object.keys(state.branchManuallySelectedByScope).some((key) =>
          key.startsWith(cachePrefix),
        ) ||
        Object.keys(state.branchResolvedRevisionByScope).some((key) =>
          key.startsWith(cachePrefix),
        );
      if (
        !(workspaceId in state.rightPanelFallbackByWorkspace) &&
        !(workspaceId in state.diffRevisionByScope) &&
        !(workspaceId in state.reviewFilesVisibleByScope) &&
        !hasInlineDiffCache &&
        !hasBranchScope
      ) {
        return {};
      }
      const rightPanelFallbackByWorkspace = { ...state.rightPanelFallbackByWorkspace };
      delete rightPanelFallbackByWorkspace[workspaceId];
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[workspaceId];
      const reviewFilesVisibleByScope = { ...state.reviewFilesVisibleByScope };
      delete reviewFilesVisibleByScope[workspaceId];
      writeReviewFilesVisibility(reviewFilesVisibleByScope);
      return {
        rightPanelFallbackByWorkspace,
        diffRevisionByScope,
        reviewFilesVisibleByScope,
        branchManuallySelectedByScope: omitByKeyPrefix(
          state.branchManuallySelectedByScope,
          cachePrefix,
        ),
        branchResolvedRevisionByScope: omitByKeyPrefix(
          state.branchResolvedRevisionByScope,
          cachePrefix,
        ),
        inlineDiffCache: omitInlineDiffCacheByPrefix(state.inlineDiffCache, cachePrefix),
      };
    }),
}));
