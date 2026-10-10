import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ReviewComparison, ReviewFileChange, ReviewTurn } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useWorkspaceFileRefresh } from "@/features/projects/files/useWorkspaceFileRefresh";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { LastTurnView } from "./LastTurnView";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView } from "./GitDiffView";
import type { DiffSource } from "@/stores/diffStore";
import { filesPaneNotice, reviewBody, type ReviewBody, type ReviewOutcome } from "./review-body";
import { ReviewLoadingPulse, ReviewStateBody } from "./ReviewStateBody";
import { ReviewStateControls } from "./FileList";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useElementWidth } from "@/hooks/useElementWidth";
import { WorktreeFilesPane } from "./WorktreeFilesPane";
import { ReviewToolbarSlotContext } from "./review-toolbar-slot";
import { cumulativeReviewFiles } from "@/lib/review-comparison";

const FILES_PANEL_MIN_WIDTH = 280;
const FILES_PANEL_DEFAULT_WIDTH = 320;
const FILES_PANEL_WIDE_WIDTH = 480;
const DIFF_VIEWPORT_MIN_WIDTH = 520;
const DOCKED_FILES_MIN_WIDTH = FILES_PANEL_MIN_WIDTH + DIFF_VIEWPORT_MIN_WIDTH;

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
  readonly liveRevision?: number;
}

interface ComparisonLoadInput {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly branchComparison: DiffStoreState["branchComparison"];
  readonly branchRange: { readonly base: string; readonly target: string } | null;
  readonly mutableComparisonRevision: number;
  readonly selectedCommitSha: string | null;
  readonly selectedTurnMessageId: string | null;
  readonly reviewTurns: readonly ReviewTurn[] | undefined;
  readonly reviewTurnsError: string | null;
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
 * An unpicked Turn view waits for the turn list: the picker seeds the latest
 * turn as soon as it arrives, and only an empty list means "No turns yet". A
 * failed list stops the wait so the body can report it.
 */
function isAwaitingTurnSelection(input: ComparisonLoadInput): boolean {
  if (input.viewMode !== "turn" || input.selectedTurnMessageId) return false;
  return input.reviewTurns === undefined ? input.reviewTurnsError === null : input.reviewTurns.length > 0;
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
        target: input.viewMode === "branch" ? input.branchRange?.target : undefined,
      });
  return {
    outcome,
    git: { source: metadata.source, id: metadata.id },
    cacheVersion: input.mutableComparisonRevision,
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
  if (input.branchComparison?.isComparisonAvailable === false || !input.branchRange) {
    return { status: "unavailable", reason: "no-base" };
  }
  return null;
}

function getGitComparisonId(input: ComparisonLoadInput & { readonly viewMode: GitView }): string {
  if (input.viewMode === "commit") return input.selectedCommitSha!;
  if (input.viewMode === "branch") return `${input.branchRange!.base}...${input.branchRange!.target}`;
  return input.activeWorkspaceId!;
}

async function loadCumulativeComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  const result = await getTransport().getCumulativeDiffStats(input.activeThreadId!);
  return {
    outcome: result.status === "ready"
      ? { status: "ready", comparison: withSnapshotFileFacts(result.comparison, input.snapshots ?? []) }
      : result,
    git: null,
    cacheVersion: input.snapshotVersion,
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
  // "turn" passes the picked operand; "last-turn" passes none and the server
  // resolves the latest turn's evidence. An unpicked "turn" must not ask at
  // all: operand-less requests resolve live/latest state the user never chose.
  if (input.viewMode === "turn" && !input.selectedTurnMessageId) {
    return {
      outcome: input.reviewTurns === undefined && input.reviewTurnsError !== null
        ? { status: "request-failed", detail: input.reviewTurnsError }
        : { status: "unselected" },
      git: null,
      cacheVersion: input.mutableComparisonRevision,
      liveRevision: input.mutableComparisonRevision,
    };
  }
  const outcome = await getTransport().getTurnDiffComparison(
    input.activeThreadId!,
    input.viewMode === "turn" ? input.selectedTurnMessageId ?? undefined : undefined,
  );
  return {
    outcome,
    git: null,
    cacheVersion: readyComparison(outcome)?.turnDiff?.id ?? input.mutableComparisonRevision,
    liveRevision: input.mutableComparisonRevision,
  };
}

/** A live comparison from before the latest mutation is stale; drop it until the refetch settles. */
function currentSettledComparison(settled: SettledComparison | null, mutableComparisonRevision: number): SettledComparison | null {
  const live = readyComparison(settled?.outcome)?.turnDiff?.phase === "live";
  return live && settled?.liveRevision !== mutableComparisonRevision ? null : settled;
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
  readonly bumpDiffRevision: DiffStoreState["bumpDiffRevision"];
  readonly diffRevision: number;
  readonly diffScopeId: string | null;
  readonly filesVisible: boolean;
  readonly requestReviewFileJump: DiffStoreState["requestReviewFileJump"];
  readonly selectedCommitSha: DiffStoreState["selectedCommitSha"];
  readonly selectedTurnMessageId: string | null;
  readonly reviewTurns: readonly ReviewTurn[] | undefined;
  readonly reviewTurnsError: string | null;
  readonly setReviewDiffStat: DiffStoreState["setReviewDiffStat"];
  readonly setReviewTurns: DiffStoreState["setReviewTurns"];
  readonly setReviewTurnsError: DiffStoreState["setReviewTurnsError"];
  readonly setReviewFilesVisible: DiffStoreState["setReviewFilesVisible"];
  readonly setSnapshots: DiffStoreState["setSnapshots"];
  readonly setSnapshotsLoading: DiffStoreState["setSnapshotsLoading"];
  readonly snapshots: DiffStoreState["snapshotsByThread"][string] | undefined;
  readonly snapshotsLoading: boolean;
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
    branchComparison: useDiffStore((state) => state.branchComparison),
    bumpDiffRevision: useDiffStore((state) => state.bumpDiffRevision),
    diffRevision,
    diffScopeId,
    filesVisible,
    requestReviewFileJump: useDiffStore((state) => state.requestReviewFileJump),
    selectedCommitSha: useDiffStore((state) => state.selectedCommitSha),
    selectedTurnMessageId: useDiffStore((state) =>
      activeThreadId ? (state.selectedTurnMessageIdByThread[activeThreadId] ?? null) : null,
    ),
    reviewTurns: useDiffStore((state) =>
      activeThreadId ? state.reviewTurnsByThread[activeThreadId] : undefined,
    ),
    reviewTurnsError: useDiffStore((state) =>
      activeThreadId ? (state.reviewTurnsErrorByThread[activeThreadId] ?? null) : null,
    ),
    setReviewDiffStat: useDiffStore((state) => state.setReviewDiffStat),
    setReviewTurns: useDiffStore((state) => state.setReviewTurns),
    setReviewTurnsError: useDiffStore((state) => state.setReviewTurnsError),
    setReviewFilesVisible: useDiffStore((state) => state.setReviewFilesVisible),
    setSnapshots: useDiffStore((state) => state.setSnapshots),
    setSnapshotsLoading: useDiffStore((state) => state.setSnapshotsLoading),
    snapshots,
    snapshotsLoading,
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
    filesPaneFits: panelWidth >= DOCKED_FILES_MIN_WIDTH,
    filesPanelWidth,
    getFilesPanelMaxWidth,
    setActiveWorktreePath,
    setFilesPanelWidth,
    setFilesVisible,
  };
}

interface ComparisonController {
  readonly branchRange: { readonly base: string; readonly target: string } | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  readonly onRefreshComparison: () => void;
  readonly onRetryComparison: () => void;
  readonly visibleSettled: SettledComparison | null;
}

function useComparisonController(store: DiffPanelStore): ComparisonController {
  const [settled, setSettled] = useState<SettledComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [snapshotRefreshRevision, setSnapshotRefreshRevision] = useState(0);
  const [turnListRevision, setTurnListRevision] = useState(0);
  const {
    activeThreadId,
    bumpDiffRevision,
    diffScopeId,
    setReviewDiffStat,
    setSnapshots,
    snapshotsLoading,
    viewMode,
  } = store;
  const comparisonIdentityRef = useRef("");
  const refreshRequestRef = useRef(0);
  const mutableComparisonRevision = getMutableComparisonRevision(store.viewMode, store.diffRevision);
  const branchRange = useMemo(
    () => getBranchRange(store.branchComparison),
    [store.branchComparison],
  );
  const comparisonIdentity = getComparisonIdentity(
    store.diffScopeId,
    store.viewMode,
    store.selectedCommitSha,
    branchRange,
    store.selectedTurnMessageId,
  );
  const snapshotVersion = getSnapshotVersion(store.snapshots);
  const comparisonLoadInput = useMemo<ComparisonLoadInput>(() => ({
    activeThreadId: store.activeThreadClientOnly ? null : store.activeThreadId,
    activeWorkspaceId: store.activeWorkspaceId,
    branchComparison: store.branchComparison,
    branchRange,
    mutableComparisonRevision,
    selectedCommitSha: store.selectedCommitSha,
    selectedTurnMessageId: store.selectedTurnMessageId,
    reviewTurns: store.reviewTurns,
    reviewTurnsError: store.reviewTurnsError,
    snapshotVersion,
    snapshots: store.snapshots,
    viewMode: store.viewMode,
  }), [
    branchRange,
    mutableComparisonRevision,
    snapshotVersion,
    store.reviewTurns,
    store.reviewTurnsError,
    store.activeThreadClientOnly,
    store.activeThreadId,
    store.activeWorkspaceId,
    store.branchComparison,
    store.selectedCommitSha,
    store.selectedTurnMessageId,
    store.snapshots,
    store.viewMode,
  ]);
  const currentSettled = currentSettledComparison(settled, mutableComparisonRevision);
  const visibleSettled = getVisibleSettledComparison(currentSettled, comparisonIdentity);
  const visibleComparison = readyComparison(visibleSettled?.outcome);
  const comparisonFiles = visibleComparison?.files ?? [];

  comparisonIdentityRef.current = comparisonIdentity;

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The toolbar-owned store must synchronize with the comparison rendered by this panel.
    setReviewDiffStat(toReviewDiffStat(visibleComparison));
  }, [setReviewDiffStat, visibleComparison]);

  useEffect(() => {
    if (!diffScopeId || !canLoadComparison(comparisonLoadInput, snapshotsLoading)) return;

    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A comparison request synchronizes pending UI state with the external transport lifecycle.
    setComparisonLoading(true);
    void loadComparison(comparisonLoadInput).then((next) => {
      if (cancelled) return;
      setSettled({ identity: comparisonIdentity, ...next });
      setComparisonLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setSettled({ identity: comparisonIdentity, outcome: requestFailedOutcome(error), git: null, cacheVersion: "" });
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

  const onRefreshComparison = useCallback(() => {
    if (cannotRefreshComparison(diffScopeId, comparisonLoading, viewMode)) return;
    if (isGitView(viewMode)) {
      bumpDiffRevision(diffScopeId!);
      return;
    }
    if (!activeThreadId) return;
    refreshSnapshots({
      activeThreadId,
      comparisonIdentity,
      comparisonIdentityRef,
      refreshRequestRef,
      setComparisonLoading,
      setSnapshotRefreshRevision,
      setSnapshots,
      onFailed: (error) => {
        setSettled({ identity: comparisonIdentity, outcome: requestFailedOutcome(error), git: null, cacheVersion: "" });
      },
    });
  }, [
    activeThreadId,
    bumpDiffRevision,
    comparisonIdentity,
    comparisonLoading,
    diffScopeId,
    setSnapshots,
    viewMode,
  ]);

  // Retry reruns the same comparison even where Refresh is hidden: a failed
  // commit comparison is immutable but still worth asking again.
  // Only a list that never arrived blocks the body; a failed background
  // refetch keeps the loaded list, so Retry then reruns the comparison.
  const turnListFailed = store.reviewTurns === undefined && store.reviewTurnsError !== null;
  const onRetryComparison = useCallback(() => {
    if (viewMode === "turn" && turnListFailed) {
      setTurnListRevision((revision) => revision + 1);
      return;
    }
    if (viewMode === "commit") {
      setSnapshotRefreshRevision((revision) => revision + 1);
      return;
    }
    onRefreshComparison();
  }, [onRefreshComparison, turnListFailed, viewMode]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useInitialSnapshots(store.activeThreadId, store.snapshots, store.setSnapshots, store.setSnapshotsLoading);
  useReviewTurns(
    store.activeThreadClientOnly ? null : store.activeThreadId,
    store.viewMode,
    `${snapshotVersion}#${turnListRevision}`,
    store.setReviewTurns,
    store.setReviewTurnsError,
  );

  return {
    branchRange,
    comparisonFiles,
    comparisonLoading,
    comparisonPending: store.snapshotsLoading || comparisonLoading || !visibleSettled,
    onRefreshComparison,
    onRetryComparison,
    visibleSettled,
  };
}

function getMutableComparisonRevision(viewMode: DiffViewMode, diffRevision: number): number {
  return viewMode === "last-turn" || (isGitView(viewMode) && viewMode !== "commit") ? diffRevision : 0;
}

function getBranchRange(
  branchComparison: DiffStoreState["branchComparison"],
): { readonly base: string; readonly target: string } | null {
  if (!branchComparison?.base || !branchComparison.target) return null;
  return { base: branchComparison.target, target: branchComparison.base };
}

function getComparisonIdentity(
  diffScopeId: string | null,
  viewMode: DiffViewMode,
  selectedCommitSha: string | null,
  branchRange: { readonly base: string; readonly target: string } | null,
  selectedTurnMessageId: string | null,
): string {
  return `${diffScopeId ?? "none"}:${viewMode}:${comparisonOperand(viewMode, selectedCommitSha, branchRange, selectedTurnMessageId)}`;
}

function comparisonOperand(
  viewMode: DiffViewMode,
  selectedCommitSha: string | null,
  branchRange: { readonly base: string; readonly target: string } | null,
  selectedTurnMessageId: string | null,
): string {
  if (viewMode === "commit") return selectedCommitSha ?? "";
  if (viewMode === "branch" && branchRange) return `${branchRange.base}...${branchRange.target}`;
  if (viewMode === "turn") return selectedTurnMessageId ?? "";
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

function toReviewDiffStat(comparison: ReviewComparison | null): DiffStoreState["reviewDiffStat"] {
  if (!comparison) return null;
  return { additions: comparison.additions, deletions: comparison.deletions };
}

function cannotRefreshComparison(
  diffScopeId: string | null,
  comparisonLoading: boolean,
  viewMode: DiffViewMode,
): boolean {
  return !diffScopeId || comparisonLoading || viewMode === "commit";
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
 * Loads the thread's turn list for the Turn view's picker and ordinals. It
 * refetches whenever `fetchKey` changes: new snapshots, so a finished turn
 * appears, or a retry after a failed list.
 */
function useReviewTurns(
  threadId: string | null,
  viewMode: DiffViewMode,
  fetchKey: string,
  setReviewTurns: DiffStoreState["setReviewTurns"],
  setReviewTurnsError: DiffStoreState["setReviewTurnsError"],
): void {
  useEffect(() => {
    if (!threadId || viewMode !== "turn") return;
    let cancelled = false;
    void getTransport().listReviewTurns(threadId).then((turns) => {
      if (!cancelled) setReviewTurns(threadId, turns);
    }).catch((error: unknown) => {
      if (!cancelled) setReviewTurnsError(threadId, error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [fetchKey, setReviewTurns, setReviewTurnsError, threadId, viewMode]);
}

/**
 * The Review (Changes) tab body: toolbar + a single scrollable diff. Dual-scope —
 * with no thread it renders the git working-tree views (Unstaged/Staged/Commit/
 * Branch) against the workspace root; with a thread it renders the turn views
 * (Last turn, Cumulative). Each view renders exactly one diff.
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
      turnOrdinal: selectedTurnOrdinal(viewMode, store.reviewTurns, store.selectedTurnMessageId),
      branchRange: comparison.branchRange,
    })
    : null;
  const handleActivateFile = (path: string) => {
    setActiveWorktreePath(path);
    if (diffScopeId) requestReviewFileJump(diffScopeId, path);
  };

  return (
    <DiffPanelLayout panelRootRef={panelRootRef}>
      <DiffPanelView
        body={body}
        comparison={comparison}
        scopeId={reviewScopeId(activeThreadId, activeWorkspaceId, viewMode)}
        selectedTurnMessageId={store.selectedTurnMessageId}
        viewMode={viewMode}
      />
      <ReviewFilesPane
        activePath={activeWorktreePath}
        comparisonFiles={comparison.comparisonFiles}
        comparisonLoading={comparison.comparisonLoading}
        filesLoading={!comparison.visibleSettled}
        filesNotice={filesPaneNotice(body)}
        filesPaneFits={filesPaneFits}
        filesPanelWidth={filesPanelWidth}
        filesVisible={filesVisible}
        getFilesPanelMaxWidth={getFilesPanelMaxWidth}
        onActivate={handleActivateFile}
        onClose={() => setFilesVisible(false)}
        onRefresh={comparison.onRefreshComparison}
        onWidthChange={setFilesPanelWidth}
        viewMode={viewMode}
      />
    </DiffPanelLayout>
  );
}

/** The Turn view names its turn by ordinal; other views have no single turn to name. */
function selectedTurnOrdinal(
  viewMode: DiffViewMode,
  reviewTurns: readonly ReviewTurn[] | undefined,
  selectedTurnMessageId: string | null,
): number | null {
  if (viewMode !== "turn" || !selectedTurnMessageId) return null;
  return reviewTurns?.find((turn) => turn.messageId === selectedTurnMessageId)?.ordinal ?? null;
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
  panelRootRef,
}: {
  readonly children: readonly [ReactNode, ReactNode];
  readonly panelRootRef: RefObject<HTMLDivElement | null>;
}) {
  const [fileControlsSlot, setFileControlsSlot] = useState<HTMLDivElement | null>(null);
  const [view, filesPane] = children;
  return (
    <div ref={panelRootRef} className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar controlsSlotRef={setFileControlsSlot} />
      <div className="relative flex min-h-0 flex-1">
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <ReviewToolbarSlotContext.Provider value={fileControlsSlot}>
            {view}
          </ReviewToolbarSlotContext.Provider>
        </ScrollArea>
        {filesPane}
      </div>
    </div>
  );
}

function DiffPanelView({
  body,
  comparison,
  scopeId,
  selectedTurnMessageId,
  viewMode,
}: {
  readonly body: ReviewBody | null;
  readonly comparison: ComparisonController;
  readonly scopeId: string | null;
  readonly selectedTurnMessageId: string | null;
  readonly viewMode: DiffViewMode;
}) {
  if (!scopeId) return null;
  const controls = (
    <ReviewStateControls
      scopeId={scopeId}
      refreshable={viewMode !== "commit"}
      refreshing={comparison.comparisonLoading}
      onRefresh={comparison.onRefreshComparison}
    />
  );
  if (!body || !comparison.visibleSettled) {
    return comparison.comparisonPending ? <>{controls}<ReviewLoadingPulse /></> : null;
  }
  if (body.kind !== "ready") {
    return <>{controls}<ReviewStateBody body={body} onRetry={comparison.onRetryComparison} /></>;
  }
  return (
    <ReadyComparisonView
      comparison={body.comparison}
      onRefresh={comparison.onRefreshComparison}
      refreshing={comparison.comparisonLoading}
      scopeId={scopeId}
      selectedTurnMessageId={selectedTurnMessageId}
      settled={comparison.visibleSettled}
      viewMode={viewMode}
    />
  );
}

function ReadyComparisonView({
  comparison,
  onRefresh,
  refreshing,
  scopeId,
  selectedTurnMessageId,
  settled,
  viewMode,
}: {
  readonly comparison: ReviewComparison;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly scopeId: string;
  readonly selectedTurnMessageId: string | null;
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
        immutable={viewMode === "commit"}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    );
  }
  if (viewMode === "cumulative") {
    return (
      <CumulativeView
        threadId={scopeId}
        comparison={comparison}
        cacheVersion={settled.cacheVersion}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    );
  }
  return (
    <LastTurnView
      threadId={scopeId}
      comparison={comparison}
      cacheVersion={settled.cacheVersion}
      refreshing={refreshing}
      onRefresh={onRefresh}
      jumpViewKey={viewMode === "turn" ? `turn:${selectedTurnMessageId ?? ""}` : "last-turn"}
    />
  );
}

function ReviewFilesPane({
  activePath,
  comparisonFiles,
  comparisonLoading,
  filesLoading,
  filesNotice,
  filesPaneFits,
  filesPanelWidth,
  filesVisible,
  getFilesPanelMaxWidth,
  onActivate,
  onClose,
  onRefresh,
  onWidthChange,
  viewMode,
}: {
  readonly activePath: string | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonLoading: boolean;
  readonly filesLoading: boolean;
  readonly filesNotice: string | null;
  readonly filesPaneFits: boolean;
  readonly filesPanelWidth: number;
  readonly filesVisible: boolean;
  readonly getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly onActivate: (path: string) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onWidthChange: (width: number) => void;
  readonly viewMode: DiffViewMode;
}) {
  // Docked only: the pane never floats. When the panel is too narrow to hold
  // both minimum widths the pane collapses; widening restores it.
  if (!filesVisible || !filesPaneFits) return null;
  return (
    <WorktreeFilesPane
      files={comparisonFiles}
      activePath={activePath}
      loading={filesLoading}
      error={filesNotice}
      width={filesPanelWidth}
      minWidth={FILES_PANEL_MIN_WIDTH}
      maxWidth={`calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`}
      defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
      wideWidth={FILES_PANEL_WIDE_WIDTH}
      getMaxWidth={getFilesPanelMaxWidth}
      onWidthChange={onWidthChange}
      onCollapseRequest={onClose}
      onClose={onClose}
      refreshable={viewMode !== "commit"}
      refreshing={comparisonLoading}
      onRefresh={onRefresh}
      onActivate={onActivate}
    />
  );
}
