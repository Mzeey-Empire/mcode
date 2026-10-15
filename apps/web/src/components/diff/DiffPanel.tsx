import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ReviewComparison, ReviewFileChange, ReviewTurn } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { sinceLookedBaseline, threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useWorkspaceFileRefresh } from "@/features/projects/files/useWorkspaceFileRefresh";
import { branchScopeKey, effectiveBranchOperands, useDiffStore, type BranchOperands, type BranchSelection, type ReviewTurnSelection } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { ReviewHeader } from "./ReviewHeader";
import { FileList } from "./FileList";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView } from "./GitDiffView";
import type { DiffSource } from "@/stores/diffStore";
import { filesPaneNotice, reviewBody, type ReviewBody, type ReviewOutcome } from "./review-body";
import { ReviewLoadingPulse, ReviewStateBody } from "./ReviewStateBody";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CommitControls } from "./CommitControls";
import { useElementWidth } from "@/hooks/useElementWidth";
import { FilesDockedPane } from "./FilesDockedPane";
import { ReviewActiveFileContext } from "./useReviewScrollSpy";
import { cumulativeReviewFiles } from "@/lib/review-comparison";
import { SIDE_PANE_CONTENT_MIN_WIDTH, sidePaneDocks } from "@/lib/side-pane-dock";

const FILES_PANEL_MIN_WIDTH = 280;
const FILES_PANEL_DEFAULT_WIDTH = 320;
const FILES_PANEL_WIDE_WIDTH = 480;
const DIFF_VIEWPORT_MIN_WIDTH = SIDE_PANE_CONTENT_MIN_WIDTH;

/** The threadless git working-tree view ids. */
const GIT_VIEWS: readonly GitView[] = ["unstaged", "staged", "commit", "branch"];
type DiffStoreState = ReturnType<typeof useDiffStore.getState>;
type DiffViewMode = DiffStoreState["viewMode"];
type Snapshot = NonNullable<DiffStoreState["snapshotsByThread"][string]>[number];

/** Where a git comparison's file patches are read from. */
interface GitComparisonSource {
  readonly source: DiffSource;
  readonly id: string;
}

interface SettledComparison {
  readonly identity: string;
  readonly outcome: ReviewOutcome;
  readonly git: GitComparisonSource | null;
  readonly cacheVersion: string | number;
  /** The turn a Turn view comparison resolved to, which names its jump key and ordinal. */
  readonly turnMessageId: string | null;
  /** The seen baseline a Since you looked comparison loaded after, which names its patches. */
  readonly afterSequence?: number;
  readonly ignoreWhitespace: boolean;
}

interface ComparisonLoadInput {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly branchComparison: DiffStoreState["branchComparison"];
  readonly branchRange: BranchOperands | null;
  readonly ignoreWhitespace: boolean;
  readonly mutableComparisonRevision: number;
  readonly selectedCommitSha: string | null;
  /** The Turn view's resolved turn: the pinned one, or the newest while following latest. */
  readonly turnMessageId: string | null;
  /** Whether the Turn view's list has ever loaded; other views ignore the list. */
  readonly reviewTurnsLoaded: boolean;
  readonly reviewTurnsError: string | null;
  /** This visit's seen baseline for Since you looked, or null when there is none. */
  readonly sinceLookedBaseline: number | null;
  readonly snapshotVersion: string;
  readonly snapshots: readonly Snapshot[] | undefined;
  readonly viewMode: DiffViewMode;
}

type LoadedComparison = Omit<SettledComparison, "identity">;

/** Type guard: whether a view mode is one of the threadless git working-tree views. */
function isGitView(mode: string): mode is GitView {
  return (GIT_VIEWS as readonly string[]).includes(mode);
}

function canLoadComparison(input: ComparisonLoadInput, snapshotsLoading: boolean): boolean {
  if (!input.activeWorkspaceId) return false;
  if (!isGitView(input.viewMode) && (!input.activeThreadId || !input.snapshots || snapshotsLoading)) {
    return false;
  }
  if (isAwaitingTurnSelection(input)) return false;
  return !isUnavailableBranchComparison(input);
}

/**
 * A Turn view following latest waits for the turn list to name the newest
 * turn. A failed list stops the wait so the body can report it.
 */
function isAwaitingTurnSelection(input: ComparisonLoadInput): boolean {
  return input.viewMode === "turn" &&
    !input.turnMessageId &&
    !input.reviewTurnsLoaded &&
    input.reviewTurnsError === null;
}

/**
 * Only a Turn view following latest whose list never arrived is blocked by
 * the list error. A pinned turn, or a list kept from an earlier load, still
 * compares.
 */
function isTurnListBlocking(input: ComparisonLoadInput): boolean {
  return input.viewMode === "turn" &&
    !input.turnMessageId &&
    !input.reviewTurnsLoaded &&
    input.reviewTurnsError !== null;
}

/** The turn the Turn view compares: the pinned turn, or the newest turn while following latest. */
function resolveTurnMessageId(
  selection: ReviewTurnSelection,
  reviewTurns: readonly ReviewTurn[] | undefined,
): string | null {
  if (selection !== "latest") return selection;
  const newest = reviewTurns?.reduce<ReviewTurn | undefined>(
    (latest, turn) => (latest === undefined || turn.ordinal > latest.ordinal ? turn : latest),
    undefined,
  );
  return newest?.messageId ?? null;
}

function isUnavailableBranchComparison(input: ComparisonLoadInput): boolean {
  return input.viewMode === "branch" &&
    !input.branchComparison?.isUnborn &&
    input.branchComparison?.isComparisonAvailable !== false &&
    !input.branchRange;
}

async function loadComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  if (isGitView(input.viewMode)) return loadGitComparison({ ...input, viewMode: input.viewMode });
  if (input.viewMode === "cumulative") return loadCumulativeComparison(input);
  if (input.viewMode === "since-looked") return loadSinceLookedComparison(input);
  return loadTurnDiffComparison(input);
}

async function loadGitComparison(
  input: ComparisonLoadInput & { readonly viewMode: GitView },
): Promise<LoadedComparison> {
  const metadata = getGitComparisonMetadata(input);
  const outcome = metadata.outcome ?? await getTransport().getReviewComparison({
        workspaceId: input.activeWorkspaceId!,
        view: input.viewMode,
        threadId: input.activeThreadId ?? undefined,
        sha: input.viewMode === "commit" ? input.selectedCommitSha ?? undefined : undefined,
        base: input.viewMode === "branch" ? input.branchRange?.base : undefined,
        compare: input.viewMode === "branch" ? input.branchRange?.compare : undefined,
        ignoreWhitespace: input.ignoreWhitespace,
      });
  return {
    outcome,
    git: { source: metadata.source, id: metadata.id },
    cacheVersion: input.mutableComparisonRevision,
    turnMessageId: null,
    ignoreWhitespace: input.ignoreWhitespace,
  };
}

function getGitComparisonMetadata(
  input: ComparisonLoadInput & { readonly viewMode: GitView },
): { readonly outcome: ReviewOutcome | null; readonly id: string; readonly source: DiffSource } {
  if (input.viewMode === "commit" && !input.selectedCommitSha) {
    return { outcome: { status: "unselected" }, source: "commit", id: input.activeWorkspaceId! };
  }
  const branchOutcome = unavailableBranchOutcome(input);
  if (branchOutcome) return { outcome: branchOutcome, source: "branch", id: "branch-unavailable" };
  return {
    outcome: null,
    source: input.viewMode,
    id: getGitComparisonId(input),
  };
}

/** The branch view's repository-level reason it has nothing to compare, if any. */
function unavailableBranchOutcome(input: ComparisonLoadInput): ReviewOutcome | null {
  if (input.viewMode !== "branch") return null;
  if (input.branchComparison?.isUnborn) return { status: "unavailable", reason: "unborn" };
  if (!input.branchRange) {
    return { status: "unavailable", reason: "no-base" };
  }
  return null;
}

function getGitComparisonId(input: ComparisonLoadInput & { readonly viewMode: GitView }): string {
  if (input.viewMode === "commit") return input.selectedCommitSha!;
  if (input.viewMode === "branch") return `${input.branchRange!.base}...${input.branchRange!.compare}`;
  return input.activeWorkspaceId!;
}

async function loadCumulativeComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  const result = await getTransport().getCumulativeDiffStats(input.activeThreadId!, undefined, {
    ignoreWhitespace: input.ignoreWhitespace,
  });
  return {
    outcome: result.status === "ready"
      ? { status: "ready", comparison: withSnapshotFileFacts(result.comparison, input.snapshots ?? []) }
      : result,
    git: null,
    cacheVersion: input.snapshotVersion,
    turnMessageId: null,
    ignoreWhitespace: input.ignoreWhitespace,
  };
}

async function loadSinceLookedComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  const baseline = input.sinceLookedBaseline;
  if (baseline === null) {
    return {
      outcome: { status: "unselected" },
      git: null,
      cacheVersion: input.snapshotVersion,
      turnMessageId: null,
      ignoreWhitespace: input.ignoreWhitespace,
    };
  }
  const result = await getTransport().getCumulativeDiffStats(input.activeThreadId!, baseline, {
    ignoreWhitespace: input.ignoreWhitespace,
  });
  // A turn whose earlier attempt settled before the baseline still gets its
  // paths and counts from the server, but its change type falls back to "modified".
  const snapshots = (input.snapshots ?? []).filter((snapshot) => snapshot.message_sequence > baseline);
  return {
    outcome: result.status === "ready"
      ? { status: "ready", comparison: withSnapshotFileFacts(result.comparison, snapshots) }
      : result,
    git: null,
    cacheVersion: input.snapshotVersion,
    turnMessageId: null,
    afterSequence: baseline,
    ignoreWhitespace: input.ignoreWhitespace,
  };
}

/**
 * The server reports cumulative paths and counts only; rename, binary, and
 * change-type facts come from the snapshots' recorded file effects.
 */
function withSnapshotFileFacts(comparison: ReviewComparison, snapshots: readonly Snapshot[]): ReviewComparison {
  const countsByPath = new Map(comparison.files.map((file) => [file.path, file]));
  return {
    ...comparison,
    files: cumulativeReviewFiles(snapshots, comparison.files.map((file) => file.path)).map((file) => {
      const counts = countsByPath.get(file.path);
      return { ...file, additions: file.binary ? null : counts?.additions ?? null, deletions: file.binary ? null : counts?.deletions ?? null };
    }),
  };
}

async function loadTurnDiffComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  // Without a resolved turn there is nothing to ask for: an operand-less
  // request would resolve live state the user never chose.
  if (!input.turnMessageId) {
    return {
      outcome: isTurnListBlocking(input) && input.reviewTurnsError !== null
        ? { status: "request-failed", detail: input.reviewTurnsError }
        : { status: "unselected" },
      git: null,
      cacheVersion: input.mutableComparisonRevision,
      turnMessageId: null,
      ignoreWhitespace: input.ignoreWhitespace,
    };
  }
  const outcome = await getTransport().getTurnDiffComparison(input.activeThreadId!, input.turnMessageId, {
    ignoreWhitespace: input.ignoreWhitespace,
  });
  return {
    outcome,
    git: null,
    // A live turn's diff id carries its revision, so it also versions the patch cache.
    cacheVersion: readyComparison(outcome)?.turnDiff?.id ?? input.mutableComparisonRevision,
    turnMessageId: input.turnMessageId,
    ignoreWhitespace: input.ignoreWhitespace,
  };
}

function readyComparison(outcome: ReviewOutcome | null | undefined): ReviewComparison | null {
  return outcome?.status === "ready" ? outcome.comparison : null;
}

/** A thrown request carries no typed outcome; its message becomes the Details text. */
function requestFailedOutcome(error: unknown): ReviewOutcome {
  return { status: "request-failed", detail: error instanceof Error ? error.message : String(error) };
}

interface DiffPanelStore {
  readonly activeThreadId: string | null;
  readonly activeThreadClientOnly: boolean;
  readonly activeWorkspaceId: string | null;
  readonly branchComparison: DiffStoreState["branchComparison"];
  readonly branchSelection: BranchSelection | undefined;
  readonly bumpDiffRevision: DiffStoreState["bumpDiffRevision"];
  readonly diffRevision: number;
  readonly diffScopeId: string | null;
  readonly filesVisible: boolean;
  readonly ignoreWhitespace: boolean;
  readonly requestReviewFileJump: DiffStoreState["requestReviewFileJump"];
  readonly selectedCommitSha: DiffStoreState["selectedCommitSha"];
  readonly turnSelection: ReviewTurnSelection;
  readonly reviewTurns: readonly ReviewTurn[] | undefined;
  readonly reviewTurnsError: string | null;
  readonly setReviewTurns: DiffStoreState["setReviewTurns"];
  readonly setReviewTurnsError: DiffStoreState["setReviewTurnsError"];
  readonly setReviewFilesVisible: DiffStoreState["setReviewFilesVisible"];
  readonly setSnapshots: DiffStoreState["setSnapshots"];
  readonly setSnapshotsLoading: DiffStoreState["setSnapshotsLoading"];
  readonly snapshots: DiffStoreState["snapshotsByThread"][string] | undefined;
  readonly snapshotsLoading: boolean;
  readonly sinceLookedBaseline: number | null;
  readonly viewMode: DiffViewMode;
}

function useDiffPanelStore(): DiffPanelStore {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  // Optimistic placeholder rows are never persisted; thread-scoped RPCs would
  // fail with "Thread not found" until the create RPC swaps in the real row.
  const activeThreadClientOnly = useWorkspaceStore((state) => {
    const row = activeThreadId
      ? state.threads.find((candidate) => candidate.id === activeThreadId)
      : undefined;
    return Boolean(row?.clientPreparing || row?.clientError);
  });
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const viewMode = useDiffStore((state) => state.viewMode);
  const snapshots = useDiffStore((state) =>
    activeThreadId ? state.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((state) =>
    activeThreadId ? (state.snapshotsLoadingByThread[activeThreadId] ?? false) : false,
  );
  const diffScopeId = activeThreadId ?? activeWorkspaceId;
  const branchScope = activeWorkspaceId ? branchScopeKey(activeWorkspaceId, activeThreadId) : null;
  const filesVisible = useDiffStore((state) =>
    diffScopeId ? (state.reviewFilesVisibleByScope[diffScopeId] ?? false) : false,
  );
  const diffRevision = useDiffStore((state) =>
    diffScopeId ? (state.diffRevisionByScope[diffScopeId] ?? 0) : 0,
  );

  return {
    activeThreadId,
    activeThreadClientOnly,
    activeWorkspaceId,
    branchComparison: useDiffStore((state) =>
      branchScope && state.branchComparisonKey === branchScope ? state.branchComparison : null,
    ),
    branchSelection: useDiffStore((state) => (branchScope ? state.branchSelectionByScope[branchScope] : undefined)),
    bumpDiffRevision: useDiffStore((state) => state.bumpDiffRevision),
    diffRevision,
    diffScopeId,
    filesVisible,
    ignoreWhitespace: useDiffStore((state) =>
      activeThreadId ? state.getIgnoreWhitespace(activeThreadId) : false,
    ),
    requestReviewFileJump: useDiffStore((state) => state.requestReviewFileJump),
    selectedCommitSha: useDiffStore((state) => state.selectedCommitSha),
    // An absent selection follows the latest turn.
    turnSelection: useDiffStore((state) =>
      activeThreadId ? (state.selectedTurnByThread[activeThreadId] ?? "latest") : "latest",
    ),
    reviewTurns: useDiffStore((state) =>
      activeThreadId ? state.reviewTurnsByThread[activeThreadId] : undefined,
    ),
    reviewTurnsError: useDiffStore((state) =>
      activeThreadId ? (state.reviewTurnsErrorByThread[activeThreadId] ?? null) : null,
    ),
    setReviewTurns: useDiffStore((state) => state.setReviewTurns),
    setReviewTurnsError: useDiffStore((state) => state.setReviewTurnsError),
    setReviewFilesVisible: useDiffStore((state) => state.setReviewFilesVisible),
    setSnapshots: useDiffStore((state) => state.setSnapshots),
    setSnapshotsLoading: useDiffStore((state) => state.setSnapshotsLoading),
    snapshots,
    snapshotsLoading,
    sinceLookedBaseline: threadAttentionStore((state) => sinceLookedBaseline(state, activeThreadId)),
    viewMode,
  };
}

interface FilesPanelController {
  readonly activeWorktreePath: string | null;
  readonly filesPaneFits: boolean;
  readonly filesPanelWidth: number;
  readonly getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly setActiveWorktreePath: (path: string | null) => void;
  readonly setFilesPanelWidth: (width: number) => void;
  readonly setFilesVisible: (visible: boolean) => void;
}

function useFilesPanelController({
  diffScopeId,
  panelRootRef,
  setReviewFilesVisible,
  viewMode,
}: {
  readonly diffScopeId: string | null;
  readonly panelRootRef: RefObject<HTMLDivElement | null>;
  readonly setReviewFilesVisible: DiffStoreState["setReviewFilesVisible"];
  readonly viewMode: DiffViewMode;
}): FilesPanelController {
  const panelWidth = useElementWidth(panelRootRef, diffScopeId ?? undefined);
  const [filesPanelWidth, setFilesPanelWidth] = useState(FILES_PANEL_DEFAULT_WIDTH);
  const filesScopeKey = `${viewMode}:${diffScopeId ?? ""}`;
  const [activeWorktreeFile, setActiveWorktreeFile] = useState<{
    readonly path: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const activeWorktreePath = activeWorktreeFile?.scopeKey === filesScopeKey
    ? activeWorktreeFile.path
    : null;
  const setFilesVisible = useCallback((visible: boolean) => {
    if (!diffScopeId) return;
    setReviewFilesVisible(diffScopeId, visible);
  }, [diffScopeId, setReviewFilesVisible]);
  const getFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number => Math.max(
      FILES_PANEL_MIN_WIDTH,
      (panel?.parentElement?.clientWidth ?? window.innerWidth) - DIFF_VIEWPORT_MIN_WIDTH,
    ),
    [],
  );

  const setActiveWorktreePath = useCallback((path: string | null) => {
    setActiveWorktreeFile({ path, scopeKey: filesScopeKey });
  }, [filesScopeKey]);

  return {
    activeWorktreePath,
    filesPaneFits: sidePaneDocks(panelWidth, FILES_PANEL_MIN_WIDTH),
    filesPanelWidth,
    getFilesPanelMaxWidth,
    setActiveWorktreePath,
    setFilesPanelWidth,
    setFilesVisible,
  };
}

interface ComparisonController {
  readonly branchRange: BranchOperands | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  /** Reloads the shown comparison; after a failed turn list it retries the list instead. */
  readonly onRefreshComparison: () => void;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}

function useComparisonController(store: DiffPanelStore): ComparisonController {
  const [settled, setSettled] = useState<SettledComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [snapshotRefreshRevision, setSnapshotRefreshRevision] = useState(0);
  const [turnListRevision, setTurnListRevision] = useState(0);
  const { activeThreadId, bumpDiffRevision, diffScopeId, setSnapshots, snapshotsLoading, viewMode } = store;
  const comparisonIdentityRef = useRef("");
  const refreshRequestRef = useRef(0);
  const settledRevisionRef = useRef(0);
  const { turnMessageId, reviewTurnsLoaded, reviewTurnsError, turnLive } = turnComparisonFacts(store);
  const mutableComparisonRevision = getMutableComparisonRevision(viewMode, store.diffRevision, turnLive);
  const branchRange = useMemo(
    () => effectiveBranchOperands(store.branchComparison, store.branchSelection),
    [store.branchComparison, store.branchSelection],
  );
  // Following latest keeps one identity across turns, so the shown diff stays
  // up until the next turn's comparison settles instead of flashing to loading.
  const comparisonIdentity = getComparisonIdentity(
    diffScopeId,
    viewMode,
    store.selectedCommitSha,
    branchRange,
    store.turnSelection,
    store.sinceLookedBaseline,
  );
  const snapshotVersion = getSnapshotVersion(store.snapshots);
  const comparisonLoadInput = useMemo<ComparisonLoadInput>(() => ({
    activeThreadId: store.activeThreadClientOnly ? null : store.activeThreadId,
    activeWorkspaceId: store.activeWorkspaceId,
    branchComparison: store.branchComparison,
    branchRange,
    ignoreWhitespace: store.ignoreWhitespace,
    mutableComparisonRevision,
    selectedCommitSha: store.selectedCommitSha,
    turnMessageId,
    reviewTurnsLoaded,
    reviewTurnsError,
    sinceLookedBaseline: store.sinceLookedBaseline,
    snapshotVersion,
    snapshots: store.snapshots,
    viewMode: store.viewMode,
  }), [
    branchRange,
    mutableComparisonRevision,
    snapshotVersion,
    reviewTurnsLoaded,
    reviewTurnsError,
    store.activeThreadClientOnly,
    store.activeThreadId,
    store.activeWorkspaceId,
    store.branchComparison,
    store.ignoreWhitespace,
    store.selectedCommitSha,
    store.sinceLookedBaseline,
    store.snapshots,
    store.viewMode,
    turnMessageId,
  ]);
  // While the Turn view waits for its list, an earlier list failure is not
  // the answer; the pulse shows instead.
  const visibleSettled = isAwaitingTurnSelection(comparisonLoadInput)
    ? null
    : getVisibleSettledComparison(settled, comparisonIdentity);
  const visibleComparison = readyComparison(visibleSettled?.outcome);

  comparisonIdentityRef.current = comparisonIdentity;

  useEffect(() => {
    if (!diffScopeId || !canLoadComparison(comparisonLoadInput, snapshotsLoading)) return;

    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A comparison request synchronizes pending UI state with the external transport lifecycle.
    setComparisonLoading(true);
    void loadComparison(comparisonLoadInput).then((next) => {
      if (cancelled) return;
      settledRevisionRef.current += 1;
      setSettled({ identity: comparisonIdentity, ...next });
      setComparisonLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      settledRevisionRef.current += 1;
      setSettled(failedComparison(comparisonIdentity, error));
      setComparisonLoading(false);
    });
    return () => { cancelled = true; };
  }, [
    comparisonIdentity,
    comparisonLoadInput,
    diffScopeId,
    snapshotRefreshRevision,
    snapshotsLoading,
  ]);

  const turnListBlocking = isTurnListBlocking(comparisonLoadInput);
  const onRefreshComparison = useCallback(() => {
    if (turnListBlocking) {
      setTurnListRevision((revision) => revision + 1);
      return;
    }
    if (!diffScopeId || comparisonLoading) return;
    // A commit never changes, but a failed read of it is still worth asking again.
    if (viewMode === "commit") {
      setSnapshotRefreshRevision((revision) => revision + 1);
      return;
    }
    if (isGitView(viewMode)) {
      bumpDiffRevision(diffScopeId);
      return;
    }
    if (!activeThreadId) return;
    setTurnListRevision((revision) => revision + 1);
    const settledRevision = settledRevisionRef.current;
    refreshSnapshots({
      activeThreadId,
      comparisonIdentity,
      comparisonIdentityRef,
      refreshRequestRef,
      setComparisonLoading,
      setSnapshotRefreshRevision,
      setSnapshots,
      onFailed: (error) => {
        // A comparison that settled after this refresh began is newer than the failure.
        if (settledRevisionRef.current !== settledRevision) return;
        setSettled(failedComparison(comparisonIdentity, error));
      },
    });
  }, [
    activeThreadId,
    bumpDiffRevision,
    comparisonIdentity,
    comparisonLoading,
    diffScopeId,
    setSnapshots,
    turnListBlocking,
    viewMode,
  ]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useInitialSnapshots(store.activeThreadId, store.snapshots, store.setSnapshots, store.setSnapshotsLoading);
  useReviewTurns(
    store.activeThreadClientOnly ? null : store.activeThreadId,
    reviewTurnsFetchKey(store, snapshotVersion, turnListRevision),
    store.setReviewTurns,
    store.setReviewTurnsError,
  );

  return {
    branchRange,
    comparisonFiles: visibleComparison?.files ?? [],
    comparisonLoading,
    comparisonPending: store.snapshotsLoading || comparisonLoading || !visibleSettled,
    onRefreshComparison,
    visibleComparison,
    visibleSettled,
  };
}

/**
 * What the Turn view's load reads from the turn list. The list refetches for
 * availability in every view, so other views read none of it, and the Turn
 * view reads only whether it loaded; a refetch alone never reloads a diff.
 */
function turnComparisonFacts(store: DiffPanelStore): {
  readonly turnMessageId: string | null;
  readonly reviewTurnsLoaded: boolean;
  readonly reviewTurnsError: string | null;
  readonly turnLive: boolean;
} {
  if (store.viewMode !== "turn") {
    return { turnMessageId: null, reviewTurnsLoaded: false, reviewTurnsError: null, turnLive: false };
  }
  const turnMessageId = resolveTurnMessageId(store.turnSelection, store.reviewTurns);
  return {
    turnMessageId,
    reviewTurnsLoaded: store.reviewTurns !== undefined,
    reviewTurnsError: store.reviewTurnsError,
    turnLive: isTurnLive(store.reviewTurns, turnMessageId),
  };
}

/**
 * Following latest refetches the list on each worktree change, so a turn that
 * starts editing becomes the newest row while it runs.
 */
function reviewTurnsFetchKey(store: DiffPanelStore, snapshotVersion: string, turnListRevision: number): string {
  const followsLatest = store.viewMode === "turn" && store.turnSelection === "latest";
  return `${snapshotVersion}#${turnListRevision}#${followsLatest ? store.diffRevision : ""}`;
}

/** A thrown request carries no typed outcome, so it settles as a failure with its message. */
function failedComparison(identity: string, error: unknown): SettledComparison {
  return {
    identity,
    outcome: requestFailedOutcome(error),
    git: null,
    cacheVersion: "",
    turnMessageId: null,
    ignoreWhitespace: false,
  };
}

/** A running turn's evidence moves with the worktree, so it refetches on each mutation; a settled turn never changes. */
function getMutableComparisonRevision(viewMode: DiffViewMode, diffRevision: number, turnLive: boolean): number {
  if (viewMode === "turn") return turnLive ? diffRevision : 0;
  return isGitView(viewMode) && viewMode !== "commit" ? diffRevision : 0;
}

function isTurnLive(reviewTurns: readonly ReviewTurn[] | undefined, turnMessageId: string | null): boolean {
  return reviewTurns?.some((turn) => turn.messageId === turnMessageId && turn.phase === "live") ?? false;
}

function getComparisonIdentity(
  diffScopeId: string | null,
  viewMode: DiffViewMode,
  selectedCommitSha: string | null,
  branchRange: BranchOperands | null,
  turnSelection: ReviewTurnSelection,
  sinceLookedBaseline: number | null,
): string {
  const operand = comparisonOperand(viewMode, selectedCommitSha, branchRange, turnSelection, sinceLookedBaseline);
  return `${diffScopeId ?? "none"}:${viewMode}:${operand}`;
}

function comparisonOperand(
  viewMode: DiffViewMode,
  selectedCommitSha: string | null,
  branchRange: BranchOperands | null,
  turnSelection: ReviewTurnSelection,
  sinceLookedBaseline: number | null,
): string {
  if (viewMode === "commit") return selectedCommitSha ?? "";
  if (viewMode === "branch" && branchRange) return `${branchRange.base}...${branchRange.compare}`;
  if (viewMode === "turn") return turnSelection;
  if (viewMode === "since-looked") return String(sinceLookedBaseline ?? "");
  return "";
}

function getSnapshotVersion(snapshots: readonly Snapshot[] | undefined): string {
  return (snapshots ?? []).map((snapshot) => `${snapshot.id}:${snapshot.ref_after}`).join("|");
}

function getVisibleSettledComparison(
  settled: SettledComparison | null,
  comparisonIdentity: string,
): SettledComparison | null {
  return settled?.identity === comparisonIdentity ? settled : null;
}

function refreshSnapshots({
  activeThreadId,
  comparisonIdentity,
  comparisonIdentityRef,
  refreshRequestRef,
  setComparisonLoading,
  setSnapshotRefreshRevision,
  setSnapshots,
  onFailed,
}: {
  readonly activeThreadId: string;
  readonly comparisonIdentity: string;
  readonly comparisonIdentityRef: RefObject<string>;
  readonly refreshRequestRef: RefObject<number>;
  readonly setComparisonLoading: (loading: boolean) => void;
  readonly setSnapshotRefreshRevision: (update: (current: number) => number) => void;
  readonly setSnapshots: DiffStoreState["setSnapshots"];
  /** A refresh that never answered replaces the shown comparison, so a stale diff can't pass for current. */
  readonly onFailed: (error: unknown) => void;
}): void {
  const requestId = ++refreshRequestRef.current;
  setComparisonLoading(true);
  getTransport().listSnapshots(activeThreadId).then((snapshots) => {
    if (!isCurrentRefreshRequest(refreshRequestRef, comparisonIdentityRef, requestId, comparisonIdentity)) return;
    setSnapshots(activeThreadId, snapshots);
    setSnapshotRefreshRevision((revision) => revision + 1);
  }).catch((error: unknown) => {
    if (isCurrentRefreshRequest(refreshRequestRef, comparisonIdentityRef, requestId, comparisonIdentity)) {
      onFailed(error);
      setComparisonLoading(false);
    }
  });
}

function isCurrentRefreshRequest(
  refreshRequestRef: RefObject<number>,
  comparisonIdentityRef: RefObject<string>,
  requestId: number,
  comparisonIdentity: string,
): boolean {
  return refreshRequestRef.current === requestId && comparisonIdentityRef.current === comparisonIdentity;
}

function useInitialSnapshots(
  activeThreadId: string | null,
  snapshots: DiffPanelStore["snapshots"],
  setSnapshots: DiffStoreState["setSnapshots"],
  setSnapshotsLoading: DiffStoreState["setSnapshotsLoading"],
): void {
  useEffect(() => {
    if (!activeThreadId || snapshots !== undefined) return;

    let cancelled = false;
    setSnapshotsLoading(activeThreadId, true);
    void getTransport().listSnapshots(activeThreadId).then((result) => {
      if (!cancelled) setSnapshots(activeThreadId, result);
    }).catch(() => {
      if (!cancelled) setSnapshots(activeThreadId, []);
    });
    return () => { cancelled = true; };
  }, [activeThreadId, setSnapshots, setSnapshotsLoading, snapshots]);
}

/**
 * Loads the thread's turn list, which the Turn picker, the body's ordinals and
 * the view menu's availability all read. It refetches whenever `fetchKey`
 * changes: new snapshots, so a finished turn appears, or a retry after a
 * failed list.
 */
function useReviewTurns(
  threadId: string | null,
  fetchKey: string,
  setReviewTurns: DiffStoreState["setReviewTurns"],
  setReviewTurnsError: DiffStoreState["setReviewTurnsError"],
): void {
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    // A retry is in flight, so the old failure no longer describes the list.
    setReviewTurnsError(threadId, null);
    void getTransport().listReviewTurns(threadId).then((turns) => {
      if (!cancelled) setReviewTurns(threadId, turns);
    }).catch((error: unknown) => {
      if (!cancelled) setReviewTurnsError(threadId, error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [fetchKey, setReviewTurns, setReviewTurnsError, threadId]);
}

/**
 * The Review (Changes) tab body: the two-row header and a single scrollable
 * diff. Dual-scope: with no thread it renders the git working-tree views
 * (Unstaged, Staged, Commit, Branch) against the workspace root; with a thread
 * it adds the turn views (Turn, All turns). Each view renders exactly one diff.
 */
export function DiffPanel() {
  const panelRootRef = useRef<HTMLDivElement>(null);
  const store = useDiffPanelStore();
  const {
    activeThreadId,
    activeWorkspaceId,
    diffScopeId,
    filesVisible,
    requestReviewFileJump,
    setReviewFilesVisible,
    viewMode,
  } = store;
  useWorkspaceFileRefresh(activeWorkspaceId, activeThreadId);
  const {
    activeWorktreePath,
    filesPaneFits,
    filesPanelWidth,
    getFilesPanelMaxWidth,
    setActiveWorktreePath,
    setFilesPanelWidth,
    setFilesVisible,
  } = useFilesPanelController({
    diffScopeId,
    panelRootRef,
    setReviewFilesVisible,
    viewMode,
  });
  const comparison = useComparisonController(store);
  const body = comparison.visibleSettled
    ? reviewBody(comparison.visibleSettled.outcome, {
      view: viewMode,
      turnOrdinal: turnOrdinal(store.reviewTurns, comparison.visibleSettled.turnMessageId),
      branchRange: comparison.branchRange,
    })
    : null;
  // The diff reports the active file once it scrolls to the jump target.
  const handleActivateFile = (path: string) => {
    if (diffScopeId) requestReviewFileJump(diffScopeId, path);
  };
  const filesNavigator = {
    files: comparison.comparisonFiles,
    activePath: activeWorktreePath,
    loading: !comparison.visibleSettled,
    error: filesPaneNotice(body),
    onActivate: handleActivateFile,
  };

  return (
    <ReviewActiveFileContext.Provider value={setActiveWorktreePath}>
      <DiffPanelLayout
        panelRootRef={panelRootRef}
        header={
          <ReviewHeader
            scopeId={diffScopeId}
            comparison={comparison.visibleComparison}
            refreshing={comparison.comparisonLoading}
            onRefresh={comparison.onRefreshComparison}
            defaultFilesExpanded={viewMode !== "cumulative" && viewMode !== "since-looked"}
            filesNavigator={{ ...filesNavigator, docked: filesPaneFits }}
          />
        }
      >
        <DiffPanelView
          body={body}
          comparison={comparison}
          scopeId={reviewScopeId(activeThreadId, activeWorkspaceId, viewMode)}
          viewMode={viewMode}
        />
        {activeWorkspaceId && diffScopeId ? (
          <CommitControls
            workspaceId={activeWorkspaceId}
            threadId={activeThreadId}
            scopeId={diffScopeId}
            activePath={activeWorktreePath}
          />
        ) : null}
        {filesVisible && filesPaneFits ? (
          <FilesDockedPane
            {...filesNavigator}
            width={filesPanelWidth}
            minWidth={FILES_PANEL_MIN_WIDTH}
            maxWidth={`calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`}
            defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
            wideWidth={FILES_PANEL_WIDE_WIDTH}
            getMaxWidth={getFilesPanelMaxWidth}
            onWidthChange={setFilesPanelWidth}
            onCollapseRequest={() => setFilesVisible(false)}
            onClose={() => setFilesVisible(false)}
            refreshing={comparison.comparisonLoading}
            onRefresh={comparison.onRefreshComparison}
          />
        ) : null}
      </DiffPanelLayout>
    </ReviewActiveFileContext.Provider>
  );
}

/** The shown Turn comparison names its turn by ordinal; other views carry no turn. */
function turnOrdinal(
  reviewTurns: readonly ReviewTurn[] | undefined,
  turnMessageId: string | null,
): number | null {
  if (!turnMessageId) return null;
  return reviewTurns?.find((turn) => turn.messageId === turnMessageId)?.ordinal ?? null;
}

/** Git views read the workspace root; thread views need a thread. */
function reviewScopeId(
  activeThreadId: string | null,
  activeWorkspaceId: string | null,
  viewMode: DiffViewMode,
): string | null {
  if (isGitView(viewMode)) return activeWorkspaceId ? activeThreadId ?? activeWorkspaceId : null;
  return activeThreadId;
}

function DiffPanelLayout({
  children,
  header,
  panelRootRef,
}: {
  readonly children: readonly [ReactNode, ReactNode, ReactNode];
  readonly header: ReactNode;
  readonly panelRootRef: RefObject<HTMLDivElement | null>;
}) {
  const [view, commitControls, filesPane] = children;
  return (
    <div ref={panelRootRef} className="flex flex-1 flex-col overflow-hidden min-h-0">
      {header}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            {view}
          </ScrollArea>
          {commitControls}
        </div>
        {filesPane}
      </div>
    </div>
  );
}

function DiffPanelView({
  body,
  comparison,
  scopeId,
  viewMode,
}: {
  readonly body: ReviewBody | null;
  readonly comparison: ComparisonController;
  readonly scopeId: string | null;
  readonly viewMode: DiffViewMode;
}) {
  if (!scopeId) return null;
  if (!body || !comparison.visibleSettled) {
    return comparison.comparisonPending ? <ReviewLoadingPulse /> : null;
  }
  if (body.kind !== "ready") {
    return <ReviewStateBody body={body} onRetry={comparison.onRefreshComparison} />;
  }
  return (
    <ReadyComparisonView
      comparison={body.comparison}
      scopeId={scopeId}
      settled={comparison.visibleSettled}
      viewMode={viewMode}
    />
  );
}

function ReadyComparisonView({
  comparison,
  scopeId,
  settled,
  viewMode,
}: {
  readonly comparison: ReviewComparison;
  readonly scopeId: string;
  readonly settled: SettledComparison;
  readonly viewMode: DiffViewMode;
}) {
  if (isGitView(viewMode)) {
    if (!settled.git) return null;
    return (
      <GitDiffView
        comparison={comparison}
        source={settled.git.source}
        id={settled.git.id}
        cacheVersion={settled.cacheVersion}
        threadId={scopeId}
        ignoreWhitespace={settled.ignoreWhitespace}
      />
    );
  }
  if (viewMode === "cumulative" || viewMode === "since-looked") {
    return (
      <CumulativeView
        threadId={scopeId}
        comparison={comparison}
        cacheVersion={settled.cacheVersion}
        ignoreWhitespace={settled.ignoreWhitespace}
        afterSequence={settled.afterSequence}
      />
    );
  }
  // A ready turn comparison always carries its turn-diff id; without one there are no patches to read.
  const turnDiffId = comparison.turnDiff?.id;
  if (!turnDiffId) return null;
  return (
    <div data-testid="review-turn" className="flex h-full min-h-0 flex-col">
      <FileList
        files={comparison.files}
        source="turn-diff"
        id={turnDiffId}
        threadId={scopeId}
        cacheVersion={settled.cacheVersion}
        ignoreWhitespace={settled.ignoreWhitespace}
        defaultFilesExpanded
        jumpViewKey={`turn:${settled.turnMessageId ?? ""}`}
      />
    </div>
  );
}
