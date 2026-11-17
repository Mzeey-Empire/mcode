import type { ReviewComparison, ReviewState } from "@mcode/contracts/models/review-comparison";
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Diff,
  Files,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button, IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { PanelHeaderSlot, PanelToolGlyph, usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
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
import { selectDiffRevision, useDiffStore, type DiffRenderMode, type DiffViewMode } from "@/stores/diffStore";
import { BranchOperandPickers } from "./BranchOperandPickers";
import { CommitOperandPicker } from "./CommitOperandPicker";
import { DiffStat } from "./DiffStat";
import { FilesPopover } from "./FilesPopover";
import type { FilesNavigatorModel } from "./FilesNavigator";
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
  /** The changed-file navigator; `docked` is true when the panel is wide enough to hold it beside the diff. */
  readonly filesNavigator: FilesNavigatorModel & { readonly docked: boolean };
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
        <PanelToolGlyph>
          <Diff />
        </PanelToolGlyph>
        {/* Named like Terminal and Browser, so the picker after it holds only the view and reads as one. The name
            goes first when the row is short, because the view and its stat are the facts: glyph 32 + name 54 +
            "Since you looked" picker 158 + "10 files +100 -100" 128 + three 8px gaps = 396px, so 400px. */}
        <span data-panel-tool-name className="shrink-0 pr-1 text-sm/5 font-medium text-ink @max-[400px]/panel-title:hidden">
          Review
        </span>
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
        // The same 32px pill as the other tools' row-1 titles, with the subtle button's hover and open fills.
        className="flex h-8 min-w-0 items-center gap-2 whitespace-nowrap rounded-control bg-selected px-3 text-sm font-medium text-ink hover:bg-[color-mix(in_oklch,var(--color-selected),var(--color-control-border))] aria-expanded:bg-control-border"
      >
        {/* The stat summary never shrinks, so the label fades only once the picker and the summary alone do not fit. */}
        <span className="text-fade">{reviewViewById(viewMode).label}</span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
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
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-caption tabular-nums text-muted"
    >
      {fileCount} {fileCount === 1 ? "file" : "files"}
      <DiffStat additions={comparison.additions} deletions={comparison.deletions} />
    </span>
  );
}

const RENDER_MODE_OPTIONS: readonly { readonly value: DiffRenderMode; readonly label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "side-by-side", label: "Split" },
];

/** Row 2: the view's operand on the left, display controls on the right. */
function ReviewControlsRow({
  scopeId,
  comparison,
  refreshing,
  onRefresh,
  defaultFilesExpanded,
  filesNavigator,
  view,
}: ReviewHeaderProps & { readonly view: ReviewView }) {
  return (
    <div data-testid="review-controls-row" className="flex h-10 min-w-0 flex-1 items-center gap-2">
      {view.id === "since-looked" ? <SinceLookedTurns /> : null}
      {view.comparison ? <FixedComparison comparison={view.comparison} /> : null}
      {view.operand ? <ReviewOperand operand={view.operand} /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        <FilesToggle scopeId={scopeId} navigator={filesNavigator} />
        <ReviewDisplayMenu comparison={comparison} defaultFilesExpanded={defaultFilesExpanded} />
      </div>
    </div>
  );
}

function ReviewOperand({ operand }: { readonly operand: ReviewView["operand"] }) {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? selectDiffRevision(s, activeThreadId ?? activeWorkspaceId) : 0,
  );
  const picker = operandPicker(operand, activeThreadId, activeWorkspaceId, diffScopeRevision);
  if (!picker) return null;
  return (
    <div className="flex min-w-0 items-center" data-testid="review-operand-slot" data-operand={operand}>
      {picker}
    </div>
  );
}

/**
 * A fixed comparison has no picker; row 2 still names both sides, laid out like the Branch pickers. The inset matches a
 * picker button's padding, so the text starts where a picker's label would, as in every other tool's row 2.
 */
function FixedComparison({ comparison: [compare, base] }: { readonly comparison: NonNullable<ReviewView["comparison"]> }) {
  return (
    <span className="flex min-w-0 items-center gap-2 px-3 text-caption text-muted" data-testid="review-operand-slot" data-operand="fixed">
      <span className="text-fade min-w-0 text-ink">{compare}</span>
      <span aria-hidden className="shrink-0 font-mono">→</span>
      <span className="sr-only">against</span>
      <span className="text-fade min-w-0">{base}</span>
    </span>
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
    <span className="shrink-0 whitespace-nowrap px-3 text-caption text-muted" data-testid="review-operand-slot" data-operand="since-looked">
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

function whitespaceUnavailableReason(threadId: string | null, comparison: ReviewComparison | null): string | null {
  if (!threadId) return "Open a thread to hide whitespace changes";
  const source = comparison?.turnDiff?.source;
  return source && source !== "git" ? "Not available for agent patches" : null;
}

/** Diff layout, rarer display choices, and the bulk fold command, kept off row 2 so the operand keeps its room. */
function ReviewDisplayMenu({
  comparison,
  defaultFilesExpanded,
}: {
  readonly comparison: ReviewComparison | null;
  readonly defaultFilesExpanded: boolean;
}) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  // Wrap and whitespace are stored per thread, so threadless scope keeps the defaults.
  const lineWrap = useDiffStore((s) => (activeThreadId ? s.getLineWrap(activeThreadId) : true));
  const ignoreWhitespace = useDiffStore((s) => (activeThreadId ? s.getIgnoreWhitespace(activeThreadId) : false));
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);
  const toggleIgnoreWhitespace = useDiffStore((s) => s.toggleIgnoreWhitespace);
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const setBulkDiffExpand = useDiffStore((s) => s.setBulkDiffExpand);
  const whitespaceReason = whitespaceUnavailableReason(activeThreadId, comparison);
  const allExpanded = bulkDiffExpand?.expand ?? defaultFilesExpanded;
  const renderMode = useDiffStore((s) => s.renderMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button variant="subtle" shape="round" className="shrink-0 text-body-small font-medium" data-testid="review-display-menu">
            <SlidersHorizontal aria-hidden />
            View
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={6}>
        {/* Diff layout lives here, as on GitHub, because a bare Unified/Split icon pair in row 2 did not say what it switched. */}
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>Layout</DropdownMenuGroupLabel>
          {RENDER_MODE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              label={option.label}
              checked={renderMode === option.value}
              data-testid={`review-render-mode-${option.value}`}
              onClick={() => setRenderMode(option.value)}
            />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          label="Wrap lines"
          checked={lineWrap}
          disabledReason={activeThreadId ? null : "Open a thread to change wrapping"}
          data-testid="review-wrap-toggle"
          onCheckedChange={() => {
            if (activeThreadId) toggleLineWrap(activeThreadId);
          }}
        />
        <DropdownMenuCheckboxItem
          label="Hide whitespace changes"
          checked={ignoreWhitespace && !whitespaceReason}
          disabledReason={whitespaceReason}
          data-testid="review-whitespace-toggle"
          onCheckedChange={() => {
            if (activeThreadId && !whitespaceReason) toggleIgnoreWhitespace(activeThreadId);
          }}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          label={allExpanded ? "Collapse all" : "Expand all"}
          icon={allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
          data-testid="review-toggle-all"
          data-expanded={allExpanded ? "true" : "false"}
          onClick={() => setBulkDiffExpand(!allExpanded)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Docked, the button shows or hides the pane and the choice persists per scope.
 * Narrower, it opens the same navigator as a popover that closes on a pick.
 */
function FilesToggle({
  scopeId,
  navigator,
}: {
  readonly scopeId: string | null;
  readonly navigator: ReviewHeaderProps["filesNavigator"];
}) {
  const filesVisible = useDiffStore((s) => (scopeId ? (s.reviewFilesVisibleByScope[scopeId] ?? false) : false));
  const setReviewFilesVisible = useDiffStore((s) => s.setReviewFilesVisible);
  const [popoverOpen, setPopoverOpen] = usePanelHeaderMenuOpen();
  const { docked } = navigator;
  // Widening the panel docks the pane, so a popover left open would reappear on narrowing.
  useEffect(() => {
    if (docked) setPopoverOpen(false);
  }, [docked, setPopoverOpen]);
  if (!docked) {
    return <FilesPopover open={popoverOpen} onOpenChange={setPopoverOpen} disabled={!scopeId} navigator={navigator} />;
  }
  return (
    <Button
      variant="subtle"
      shape="round"
      aria-label={filesVisible ? "Hide files" : "Show files"}
      aria-pressed={filesVisible}
      disabled={!scopeId}
      data-testid="review-files-toggle"
      className="shrink-0 text-body-small font-medium"
      onClick={() => {
        if (scopeId) setReviewFilesVisible(scopeId, !filesVisible);
      }}
    >
      <Files aria-hidden />
      Files
    </Button>
  );
}
