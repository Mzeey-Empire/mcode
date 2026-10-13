import type { ReviewComparison, ReviewState } from "@mcode/contracts";
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Files,
  RefreshCw,
  Rows2,
  TextWrap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { PanelHeaderSlot, usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { sinceLookedBaseline, threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useReviewState } from "@/hooks/useReviewState";
import type { PanelScope } from "@/lib/panel-tabs";
import {
  REVIEW_VIEW_GROUPS,
  defaultReviewView,
  reviewViewAvailability,
  reviewViewById,
  sinceLookedMessageIds,
  sinceLookedTurnsLabel,
  type ReviewChangeState,
  type ReviewView,
  type ReviewViewAvailabilityMap,
} from "@/lib/review-views";
import { useDiffStore, type DiffRenderMode, type DiffViewMode } from "@/stores/diffStore";
import { BranchOperandPickers } from "./BranchOperandPickers";
import { CommitOperandPicker } from "./CommitOperandPicker";
import { DiffStat } from "./DiffStat";
import { FileJumpPopover } from "./FileList";
import { TurnPicker } from "./TurnPicker";

/** What the header shows about the comparison the panel body renders. */
export interface ReviewHeaderProps {
  /** Diff scope (thread or workspace id) that owns Files visibility and file jumps. */
  readonly scopeId: string | null;
  /** The settled comparison on screen, or null while none is ready. */
  readonly comparison: ReviewComparison | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  /** Whether the current view opens its files expanded, which seeds Expand/Collapse all. */
  readonly defaultFilesExpanded: boolean;
}

/**
 * The Review tab's two header rows. Row 1 names the view and its stat; row 2
 * holds the view's operand on the left and the display controls on the right.
 * Row 2 renders in every view and state, so Refresh never disappears with the
 * file list.
 */
export function ReviewHeader(props: ReviewHeaderProps) {
  const selection = useReviewViewSelection();
  return (
    <>
      <PanelHeaderSlot slot="leading">
        <ReviewViewMenu selection={selection} />
        <ReviewStatSummary comparison={props.comparison} />
      </PanelHeaderSlot>
      <PanelHeaderSlot slot="row2">
        <ReviewControlsRow {...props} view={reviewViewById(selection.viewMode)} />
      </PanelHeaderSlot>
    </>
  );
}

interface ReviewViewSelection {
  readonly activeThreadId: string | null;
  readonly availability: ReviewViewAvailabilityMap;
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly select: (id: DiffViewMode) => void;
  readonly viewMode: DiffViewMode;
}

const NOT_A_GIT_REPOSITORY: ReviewState = { isGitRepo: false };

/**
 * The active view, every view's availability, and the menu's open state. It
 * also keeps the store's view on an available one: a thread follows its
 * ADR-0011 default or sticky pick, and threadless scope leaves the view alone
 * unless it cannot load.
 */
function useReviewViewSelection(): ReviewViewSelection {
  const viewMode = useDiffStore((s) => s.viewMode);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setReviewViewForThread = useDiffStore((s) => s.setReviewViewForThread);
  const [menuOpen, setMenuOpen, probeNonce] = useViewMenuOpen();
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const isGitRepo = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.is_git_repo ?? false,
  );
  const turns = useDiffStore((s) => (activeThreadId ? s.reviewTurnsByThread[activeThreadId] ?? null : null));
  const snapshots = useDiffStore((s) => (activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined));
  const baseline = threadAttentionStore((s) => sinceLookedBaseline(s, activeThreadId));
  const hasTurnChanges = useDiffStore((s) =>
    activeThreadId ? (s.snapshotsByThread[activeThreadId] ?? []).some((snap) => snap.files_changed.length > 0) : false,
  );
  const probe = useReviewState(isGitRepo ? activeWorkspaceId : null, activeThreadId, probeNonce);
  const scope: PanelScope = activeThreadId ? "thread" : "threadless";
  const reviewState = isGitRepo ? probe.state : NOT_A_GIT_REPOSITORY;
  const availability = useMemo(
    () => reviewViewAvailability(scope, reviewState, turns, { baseline, snapshots }),
    [scope, reviewState, turns, baseline, snapshots],
  );
  // A probe in flight reads as clean, which would flip a dirty thread's
  // default to Branch until it answers; wait for the answer instead.
  const probing = isGitRepo && probe.state === null && probe.error === null;
  useViewSynchronization({
    activeThreadId,
    availability,
    changeState: { hasTurnChanges, isDirty: probe.isDirty },
    probing,
    setViewMode,
    viewMode,
  });

  const select = (id: DiffViewMode) => {
    if (!availability[id].available) return;
    if (activeThreadId) setReviewViewForThread(activeThreadId, id);
    else setViewMode(id);
  };
  return { activeThreadId, availability, menuOpen, setMenuOpen, select, viewMode };
}

/**
 * The view menu's shared open flag, plus a nonce that bumps on each open so
 * availability is probed fresh whenever the menu shows it.
 */
function useViewMenuOpen(): readonly [boolean, (open: boolean) => void, number] {
  const menuOpen = useDiffStore((s) => s.reviewViewMenuOpen);
  const setMenuOpen = useDiffStore((s) => s.setReviewViewMenuOpen);
  // The gate hides the menu while Review or the panel is hidden; clearing the
  // shared flag keeps it from popping back open when Review returns.
  const overlaysOpen = useContext(OverlayGateContext);
  useEffect(() => {
    if (!overlaysOpen && menuOpen) setMenuOpen(false);
  }, [overlaysOpen, menuOpen, setMenuOpen]);
  const [probeNonce, setProbeNonce] = useState(0);
  // The menu can also be opened from a review state body ("Choose another
  // view"), so the probe follows the shared open flag.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Opening the view menu must re-probe repository state, whichever surface opened it.
    if (menuOpen) setProbeNonce((nonce) => nonce + 1);
  }, [menuOpen]);
  return [menuOpen, setMenuOpen, probeNonce];
}

interface ViewSynchronizationInput {
  readonly activeThreadId: string | null;
  readonly availability: ReviewViewAvailabilityMap;
  readonly changeState: ReviewChangeState;
  readonly probing: boolean;
  readonly setViewMode: (mode: DiffViewMode) => void;
  readonly viewMode: DiffViewMode;
}

function useViewSynchronization(input: ViewSynchronizationInput): void {
  const getReviewView = useDiffStore((s) => s.getReviewView);
  const { activeThreadId, availability, probing, setViewMode, viewMode } = input;
  const { hasTurnChanges, isDirty } = input.changeState;
  // The sticky pick lives in the store, so a pick must rerun the sync.
  const pickedView = useDiffStore((s) => (activeThreadId ? s.reviewViewByThread[activeThreadId] : undefined));
  const manuallySelected = useDiffStore((s) =>
    activeThreadId ? (s.reviewViewManuallySelectedByThread[activeThreadId] ?? false) : false,
  );
  useEffect(() => {
    if (probing) return;
    const changeState = { hasTurnChanges, isDirty };
    const target = activeThreadId
      ? threadReviewView(getReviewView(activeThreadId, changeState, availability), changeState, availability)
      : threadlessReviewView(viewMode, changeState, availability);
    if (target !== viewMode) setViewMode(target);
  }, [
    activeThreadId,
    availability,
    getReviewView,
    hasTurnChanges,
    isDirty,
    manuallySelected,
    pickedView,
    probing,
    setViewMode,
    viewMode,
  ]);
}

/** A thread's wanted view, unless it cannot load, in which case its default. */
function threadReviewView(
  wanted: DiffViewMode,
  changeState: ReviewChangeState,
  availability: ReviewViewAvailabilityMap,
): DiffViewMode {
  return availability[wanted].available ? wanted : defaultReviewView("thread", changeState, availability);
}

/** Threadless scope keeps the current view until it cannot load. */
function threadlessReviewView(
  current: DiffViewMode,
  changeState: ReviewChangeState,
  availability: ReviewViewAvailabilityMap,
): DiffViewMode {
  return availability[current].available ? current : defaultReviewView("threadless", changeState, availability);
}

/** Names-only view menu: groups split by dividers, unavailable views dimmed with their reason. */
function ReviewViewMenu({ selection }: { readonly selection: ReviewViewSelection }) {
  const { availability, menuOpen, setMenuOpen, select, viewMode } = selection;
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        data-testid="review-view-switcher"
        aria-label="Select review view"
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-caption font-medium tracking-tight text-ink hover:bg-selected"
      >
        {reviewViewById(viewMode).label}
        <ChevronDown size={11} className="text-muted/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[150px]">
        {REVIEW_VIEW_GROUPS.map((group, index) => (
          <Fragment key={group[0].id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((view) => (
              <ReviewViewMenuItem
                key={view.id}
                view={view}
                active={view.id === viewMode}
                availability={availability}
                onSelect={select}
              />
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReviewViewMenuItem({
  view,
  active,
  availability,
  onSelect,
}: {
  readonly view: ReviewView;
  readonly active: boolean;
  readonly availability: ReviewViewAvailabilityMap;
  readonly onSelect: (id: DiffViewMode) => void;
}) {
  const state = availability[view.id];
  return (
    <DropdownMenuItem
      label={view.label}
      checked={active}
      disabledReason={state.available ? null : state.reason}
      onClick={() => onSelect(view.id)}
      data-testid={`review-view-${view.id}`}
      data-active={active ? "true" : undefined}
    />
  );
}

/** "N files +A -D" for the comparison on screen; absent while none is ready or it has no files. */
function ReviewStatSummary({ comparison }: { readonly comparison: ReviewComparison | null }) {
  const fileCount = comparison?.files.length ?? 0;
  if (!comparison || fileCount === 0) return null;
  return (
    <span
      data-testid="review-stat-summary"
      className="text-fade flex items-center gap-1.5 font-mono text-caption tabular-nums text-muted"
    >
      {fileCount} {fileCount === 1 ? "file" : "files"}
      <DiffStat additions={comparison.additions} deletions={comparison.deletions} />
    </span>
  );
}

const RENDER_MODE_OPTIONS = [
  { value: "unified", label: "Unified", title: "Unified", icon: <Rows2 className="size-4" aria-hidden /> },
  { value: "side-by-side", label: "Split", title: "Split", icon: <Columns2 className="size-4" aria-hidden /> },
] as const;

function isRenderMode(value: string): value is DiffRenderMode {
  return RENDER_MODE_OPTIONS.some((option) => option.value === value);
}

/** Row 2: the view's operand on the left, display controls on the right. */
function ReviewControlsRow({
  scopeId,
  comparison,
  refreshing,
  onRefresh,
  defaultFilesExpanded,
  view,
}: ReviewHeaderProps & { readonly view: ReviewView }) {
  return (
    <div data-testid="review-controls-row" className="flex h-10 min-w-0 flex-1 items-center gap-2">
      {view.id === "since-looked" ? <SinceLookedTurns /> : <ReviewOperand operand={view.operand} />}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        <RenderModePill />
        <WrapToggle />
        {/* S10-13 places the whitespace toggle here. */}
        <span data-testid="review-whitespace-slot" />
        <ToggleAllButton defaultFilesExpanded={defaultFilesExpanded} />
        <FileJump scopeId={scopeId} comparison={comparison} />
        <FilesToggle scopeId={scopeId} />
      </div>
    </div>
  );
}

function ReviewOperand({ operand }: { readonly operand: ReviewView["operand"] }) {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? (s.diffRevisionByScope[activeThreadId ?? activeWorkspaceId] ?? 0) : 0,
  );
  const picker = operandPicker(operand, activeThreadId, activeWorkspaceId, diffScopeRevision);
  if (!picker) return null;
  return (
    <div className="flex min-w-0 items-center" data-testid="review-operand-slot" data-operand={operand}>
      {picker}
    </div>
  );
}

/** Since you looked has no picker; row 2 names the turns it covers as plain text. */
function SinceLookedTurns() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const baseline = threadAttentionStore((s) => sinceLookedBaseline(s, activeThreadId));
  const snapshots = useDiffStore((s) => (activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined));
  const turns = useDiffStore((s) => (activeThreadId ? s.reviewTurnsByThread[activeThreadId] : undefined));
  const label = baseline === null || !snapshots || !turns
    ? null
    : sinceLookedTurnsLabel(turns, sinceLookedMessageIds(snapshots, baseline));
  if (!label) return null;
  return (
    <span className="shrink-0 whitespace-nowrap text-caption text-muted" data-testid="review-operand-slot" data-operand="since-looked">
      {label}
    </span>
  );
}

function operandPicker(
  operand: ReviewView["operand"],
  threadId: string | null,
  workspaceId: string | null,
  diffScopeRevision: number,
) {
  if (operand === "commit" && workspaceId) {
    return (
      <CommitOperandPicker
        key={`${workspaceId}:${threadId ?? ""}`}
        workspaceId={workspaceId}
        threadId={threadId ?? undefined}
        diffScopeRevision={diffScopeRevision}
      />
    );
  }
  if (operand === "turn" && threadId) return <TurnPicker threadId={threadId} />;
  if (operand === "branch" && workspaceId) {
    return (
      <BranchOperandPickers
        workspaceId={workspaceId}
        threadId={threadId ?? undefined}
        diffScopeRevision={diffScopeRevision}
      />
    );
  }
  return null;
}

function RefreshButton({ refreshing, onRefresh }: { readonly refreshing: boolean; readonly onRefresh: () => void }) {
  return (
    <IconButton
      shape="round"
      aria-label={refreshing ? "Refreshing" : "Refresh"}
      disabled={refreshing}
      data-testid="review-refresh"
      onClick={onRefresh}
    >
      {refreshing ? <Spinner size={16} /> : <RefreshCw />}
    </IconButton>
  );
}

function RenderModePill() {
  const renderMode = useDiffStore((s) => s.renderMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  return (
    <span data-testid="review-render-mode" className="contents">
      <SegmentedControl
        size="compact"
        iconOnly
        aria-label="Diff layout"
        options={RENDER_MODE_OPTIONS}
        value={renderMode}
        onChange={(value) => {
          if (isRenderMode(value)) setRenderMode(value);
        }}
        // Paper draws row 2's pill as two 28px icon segments with the active one
        // filled by the control border, so the operand keeps its width.
        className="[&_[role=radio]]:w-7 [&_[role=radio][aria-checked=true]]:bg-control-border"
      />
    </span>
  );
}

function WrapToggle() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const lineWrap = useDiffStore((s) => (activeThreadId ? s.getLineWrap(activeThreadId) : true));
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);
  // Wrap is stored per thread, so threadless scope keeps the default on.
  return (
    <IconButton
      shape="round"
      aria-label="Wrap lines"
      tooltip={activeThreadId ? "Wrap lines" : "Open a thread to change wrapping"}
      pressed={lineWrap}
      disabled={!activeThreadId}
      data-testid="review-wrap-toggle"
      onClick={() => {
        if (activeThreadId) toggleLineWrap(activeThreadId);
      }}
    >
      <TextWrap />
    </IconButton>
  );
}

function ToggleAllButton({ defaultFilesExpanded }: { readonly defaultFilesExpanded: boolean }) {
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const setBulkDiffExpand = useDiffStore((s) => s.setBulkDiffExpand);
  const allExpanded = bulkDiffExpand?.expand ?? defaultFilesExpanded;
  const label = allExpanded ? "Collapse all" : "Expand all";
  return (
    <IconButton
      shape="round"
      aria-label={label}
      data-testid="review-toggle-all"
      data-expanded={allExpanded ? "true" : "false"}
      onClick={() => setBulkDiffExpand(!allExpanded)}
    >
      {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
    </IconButton>
  );
}

function FileJump({ scopeId, comparison }: { readonly scopeId: string | null; readonly comparison: ReviewComparison | null }) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const requestReviewFileJump = useDiffStore((s) => s.requestReviewFileJump);
  const paths = useMemo(
    () => (comparison?.files ?? []).map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    [comparison],
  );
  if (!scopeId || paths.length === 0) return null;
  return (
    <FileJumpPopover
      open={open}
      onOpenChange={setOpen}
      files={paths}
      onJumpToFile={(path) => {
        setOpen(false);
        requestReviewFileJump(scopeId, path);
      }}
    />
  );
}

function FilesToggle({ scopeId }: { readonly scopeId: string | null }) {
  const filesVisible = useDiffStore((s) => (scopeId ? (s.reviewFilesVisibleByScope[scopeId] ?? false) : false));
  const setReviewFilesVisible = useDiffStore((s) => s.setReviewFilesVisible);
  return (
    <IconButton
      shape="round"
      aria-label={filesVisible ? "Hide files" : "Show files"}
      pressed={filesVisible}
      disabled={!scopeId}
      data-testid="review-files-toggle"
      onClick={() => {
        if (scopeId) setReviewFilesVisible(scopeId, !filesVisible);
      }}
    >
      <Files />
    </IconButton>
  );
}
