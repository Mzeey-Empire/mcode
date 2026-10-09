import type { ReviewState } from "@mcode/contracts";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useReviewState } from "@/hooks/useReviewState";
import type { PanelScope } from "@/lib/panel-tabs";
import { visibleReviewViews, defaultReviewView } from "@/lib/review-views";
import { BranchRefPicker } from "./BranchRefPicker";
import { CommitPicker } from "./CommitPicker";
import { TurnPicker } from "./TurnPicker";
import { ReviewActions } from "./ReviewActions";
import { DiffStat } from "./DiffStat";

type CommitAvailability = "loading" | "available" | "empty";
type BranchAvailability = "loading" | "available" | "empty";
type DiffStoreState = ReturnType<typeof useDiffStore.getState>;
type WorkspaceThread = ReturnType<typeof useWorkspaceStore.getState>["threads"][number];
type ReviewViewMode = ReturnType<typeof visibleReviewViews>[number];

interface ReviewViewSynchronizationInput {
  readonly activeThreadId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly getReviewView: DiffStoreState["getReviewView"];
  readonly hasTurnChanges: boolean;
  readonly pinnedReviewView: DiffStoreState["reviewViewByThread"][string] | undefined;
  readonly reviewViewManuallySelected: boolean;
  readonly scope: PanelScope;
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
  readonly workingTreeDirty: boolean;
}

/** Toolbar for the Review tab: dual-scope view switcher + review actions. */
export function DiffToolbar({
  controlsSlotRef,
}: {
  /** Host element the FileList controls portal into, keeping one toolbar row. */
  readonly controlsSlotRef?: (el: HTMLDivElement | null) => void;
}) {
  const viewMode = useDiffStore((s) => s.viewMode);
  const reviewFileCount = useDiffStore((s) => s.reviewFileCount);
  const reviewDiffStat = useDiffStore((s) => s.reviewDiffStat);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setReviewViewForThread = useDiffStore((s) => s.setReviewViewForThread);
  const getReviewView = useDiffStore((s) => s.getReviewView);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [reviewProbeNonce, setReviewProbeNonce] = useState(0);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThread = useWorkspaceStore(
    (s) => s.threads.find((t) => t.id === s.activeThreadId) ?? null,
  );
  const diffScopeRevision = useDiffStore((s) =>
    activeWorkspaceId ? (s.diffRevisionByScope[activeThreadId ?? activeWorkspaceId] ?? 0) : 0,
  );

  const isGitRepo = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.is_git_repo ?? false,
  );

  // Change-state signals for the per-thread default (ADR-0011).
  const reviewViewManuallySelected = useDiffStore((s) =>
    activeThreadId ? (s.reviewViewManuallySelectedByThread[activeThreadId] ?? false) : false,
  );
  const pinnedReviewView = useDiffStore((s) =>
    activeThreadId ? s.reviewViewByThread[activeThreadId] : undefined,
  );
  const hasTurnChanges = useDiffStore((s) => {
    if (!activeThreadId) return false;
    const snaps = s.snapshotsByThread[activeThreadId];
    return !!snaps && snaps.some((snap) => snap.files_changed.length > 0);
  });

  // The Review tab is dual-scope: threadless yields the git working-tree views,
  // a thread yields the turn views. Runtime gates drop the git views in a
  // non-git workspace.
  const scope: PanelScope = activeThreadId ? "thread" : "threadless";
  const viewModes = useMemo(
    () => visibleReviewViews(scope, { isGitRepo }),
    [scope, isGitRepo],
  );
  const { state: reviewState, isDirty: workingTreeDirty } = useReviewState(
    isGitRepo ? activeWorkspaceId : null, activeThreadId, reviewProbeNonce,
  );
  const { commitAvailability, branchAvailability } = reviewAvailability(reviewState, isGitRepo);

  useReviewViewSynchronization({
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  });

  const activeView = useMemo(
    () => viewModes.find((m) => m.id === viewMode),
    [viewModes, viewMode],
  );

  return (
    <DiffToolbarContent
      activeThread={activeThread}
      activeThreadId={activeThreadId}
      activeView={activeView}
      activeWorkspaceId={activeWorkspaceId}
      branchAvailability={branchAvailability}
      commitAvailability={commitAvailability}
      diffScopeRevision={diffScopeRevision}
      onViewMenuOpenChange={(open) => {
        setViewMenuOpen(open);
        if (open) {
          setReviewProbeNonce((nonce) => nonce + 1);
        }
      }}
      reviewDiffStat={reviewDiffStat}
      reviewFileCount={reviewFileCount}
      setReviewViewForThread={setReviewViewForThread}
      setViewMode={setViewMode}
      viewMenuOpen={viewMenuOpen}
      viewMode={viewMode}
      viewModes={viewModes}
      controlsSlotRef={controlsSlotRef}
    />
  );
}

function reviewAvailability(state: ReviewState | null, isGitRepo: boolean): {
  commitAvailability: CommitAvailability;
  branchAvailability: BranchAvailability;
} {
  if (!isGitRepo || state?.isGitRepo === false) return { commitAvailability: "empty", branchAvailability: "empty" };
  if (!state) return { commitAvailability: "loading", branchAvailability: "loading" };
  return {
    commitAvailability: (state.commitsAhead?.count ?? 0) > 0 ? "available" : "empty",
    branchAvailability: "compare" in state.branchDefault ? "available" : "empty",
  };
}

function useReviewViewSynchronization(input: ReviewViewSynchronizationInput): void {
  const {
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  } = input;

  useEffect(() => {
    synchronizeReviewView({
      activeThreadId,
      branchAvailability,
      commitAvailability,
      getReviewView,
      hasTurnChanges,
      pinnedReviewView,
      reviewViewManuallySelected,
      scope,
      setViewMode,
      viewMode,
      viewModes,
      workingTreeDirty,
    });
  }, [
    activeThreadId,
    branchAvailability,
    commitAvailability,
    getReviewView,
    hasTurnChanges,
    pinnedReviewView,
    reviewViewManuallySelected,
    scope,
    setViewMode,
    viewMode,
    viewModes,
    workingTreeDirty,
  ]);
}

function synchronizeReviewView(input: ReviewViewSynchronizationInput): void {
  if (input.viewModes.length === 0) return;
  if (input.activeThreadId) {
    synchronizeThreadReviewView(input);
    return;
  }
  synchronizeThreadlessReviewView(input);
}

function synchronizeThreadReviewView(input: ReviewViewSynchronizationInput): void {
  const wantedView = input.getReviewView(input.activeThreadId!, {
    hasTurnChanges: input.hasTurnChanges,
    isDirty: input.workingTreeDirty,
  });
  const target = isAvailableThreadReviewView(wantedView, input)
    ? wantedView
    : input.viewModes[0].id;
  if (input.viewMode !== target) input.setViewMode(target);
}

function isAvailableThreadReviewView(
  wantedView: DiffStoreState["viewMode"],
  input: ReviewViewSynchronizationInput,
): boolean {
  return input.viewModes.some((mode) => mode.id === wantedView) &&
    !(wantedView === "commit" && input.commitAvailability === "empty");
}

function synchronizeThreadlessReviewView(input: ReviewViewSynchronizationInput): void {
  if (!isInvalidThreadlessReviewView(input)) return;
  const fallback = defaultReviewView(input.scope);
  const target = input.viewModes.some((mode) => mode.id === fallback)
    ? fallback
    : input.viewModes[0].id;
  input.setViewMode(target);
}

function isInvalidThreadlessReviewView(input: ReviewViewSynchronizationInput): boolean {
  return !input.viewModes.some((mode) => mode.id === input.viewMode) ||
    (input.viewMode === "commit" && input.commitAvailability === "empty") ||
    (input.viewMode === "branch" && input.branchAvailability === "empty");
}

function DiffToolbarContent({
  activeThread,
  activeThreadId,
  activeView,
  activeWorkspaceId,
  branchAvailability,
  commitAvailability,
  diffScopeRevision,
  onViewMenuOpenChange,
  reviewDiffStat,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
  controlsSlotRef,
}: {
  readonly activeThread: WorkspaceThread | null;
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly activeWorkspaceId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly controlsSlotRef?: (el: HTMLDivElement | null) => void;
  readonly diffScopeRevision: number;
  readonly onViewMenuOpenChange: (open: boolean) => void;
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-y-1.5 px-3 py-2 border-b border-border/30">
      <ReviewToolbarStart
        activeThreadId={activeThreadId}
        activeView={activeView}
        branchAvailability={branchAvailability}
        commitAvailability={commitAvailability}
        onViewMenuOpenChange={onViewMenuOpenChange}
        reviewDiffStat={reviewDiffStat}
        reviewFileCount={reviewFileCount}
        setReviewViewForThread={setReviewViewForThread}
        setViewMode={setViewMode}
        viewMenuOpen={viewMenuOpen}
        viewMode={viewMode}
        viewModes={viewModes}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <div
          ref={controlsSlotRef}
          data-testid="review-file-controls-slot"
          className="flex items-center gap-0.5"
        />
        <ReviewToolbarActions activeThread={activeThread} />
      </div>
      <BranchOperand
        activeThreadId={activeThreadId}
        activeView={activeView}
        activeWorkspaceId={activeWorkspaceId}
        diffScopeRevision={diffScopeRevision}
      />
    </div>
  );
}

function ReviewToolbarStart({
  activeThreadId,
  activeView,
  branchAvailability,
  commitAvailability,
  onViewMenuOpenChange,
  reviewDiffStat,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly onViewMenuOpenChange: (open: boolean) => void;
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ReviewViewMenu
        activeThreadId={activeThreadId}
        activeView={activeView}
        branchAvailability={branchAvailability}
        commitAvailability={commitAvailability}
        onOpenChange={onViewMenuOpenChange}
        reviewFileCount={reviewFileCount}
        setReviewViewForThread={setReviewViewForThread}
        setViewMode={setViewMode}
        viewMenuOpen={viewMenuOpen}
        viewMode={viewMode}
        viewModes={viewModes}
      />
      <ReviewDiffStat reviewDiffStat={reviewDiffStat} reviewFileCount={reviewFileCount} />
      <CommitOperand activeView={activeView} />
      <TurnOperand activeView={activeView} activeThreadId={activeThreadId} />
    </div>
  );
}

function ReviewViewMenu({
  activeThreadId,
  activeView,
  branchAvailability,
  commitAvailability,
  onOpenChange,
  reviewFileCount,
  setReviewViewForThread,
  setViewMode,
  viewMenuOpen,
  viewMode,
  viewModes,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly onOpenChange: (open: boolean) => void;
  readonly reviewFileCount: number | null;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMenuOpen: boolean;
  readonly viewMode: DiffStoreState["viewMode"];
  readonly viewModes: readonly ReviewViewMode[];
}) {
  return (
    <DropdownMenu open={viewMenuOpen} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        data-testid="review-view-switcher"
        disabled={viewModes.length === 0}
        aria-label="Select review view"
        className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium tracking-tight text-ink hover:bg-selected disabled:pointer-events-none disabled:opacity-50"
      >
        {activeView?.label ?? "-"}
        <ReviewFileCount fileCount={reviewFileCount} />
        <ChevronDown size={11} className="text-muted/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[150px]">
        {viewModes.map((mode) => (
          <ReviewViewMenuItem
            key={mode.id}
            activeThreadId={activeThreadId}
            branchAvailability={branchAvailability}
            commitAvailability={commitAvailability}
            mode={mode}
            setReviewViewForThread={setReviewViewForThread}
            setViewMode={setViewMode}
            viewMode={viewMode}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReviewFileCount({ fileCount }: { readonly fileCount: number | null }) {
  if (fileCount === null || fileCount <= 0) return null;
  return (
    <span
      className="ml-1 rounded-full bg-muted/15 px-1.5 text-caption font-medium tabular-nums text-muted"
      data-testid="review-file-count"
    >
      {fileCount}
    </span>
  );
}

function ReviewViewMenuItem({
  activeThreadId,
  branchAvailability,
  commitAvailability,
  mode,
  setReviewViewForThread,
  setViewMode,
  viewMode,
}: {
  readonly activeThreadId: string | null;
  readonly branchAvailability: BranchAvailability;
  readonly commitAvailability: CommitAvailability;
  readonly mode: ReviewViewMode;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
  readonly viewMode: DiffStoreState["viewMode"];
}) {
  const active = viewMode === mode.id;
  const unavailableReason = reviewViewUnavailableReason(mode, commitAvailability, branchAvailability);
  return (
    <DropdownMenuItem
      label={mode.label}
      checked={active}
      disabledReason={unavailableReason}
      onClick={() => selectReviewView({
        activeThreadId,
        disabled: unavailableReason !== null,
        mode,
        setReviewViewForThread,
        setViewMode,
      })}
      data-testid={`review-view-${mode.id}`}
      data-active={active ? "true" : undefined}
    />
  );
}

function reviewViewUnavailableReason(
  mode: ReviewViewMode,
  commitAvailability: CommitAvailability,
  branchAvailability: BranchAvailability,
): string | null {
  if (mode.id === "commit" && commitAvailability === "empty") return "No commits to review";
  if (mode.id === "branch" && branchAvailability === "empty") return "No branch changes to review";
  return null;
}

function selectReviewView({
  activeThreadId,
  disabled,
  mode,
  setReviewViewForThread,
  setViewMode,
}: {
  readonly activeThreadId: string | null;
  readonly disabled: boolean;
  readonly mode: ReviewViewMode;
  readonly setReviewViewForThread: DiffStoreState["setReviewViewForThread"];
  readonly setViewMode: DiffStoreState["setViewMode"];
}): void {
  if (disabled) return;
  if (activeThreadId) {
    setReviewViewForThread(activeThreadId, mode.id);
    return;
  }
  setViewMode(mode.id);
}

function ReviewDiffStat({
  reviewDiffStat,
  reviewFileCount,
}: {
  readonly reviewDiffStat: DiffStoreState["reviewDiffStat"];
  readonly reviewFileCount: number | null;
}) {
  if (reviewDiffStat === null && reviewFileCount !== null && reviewFileCount > 0) {
    return (
      <Spinner
        size={12}
        className="text-muted/50"
        aria-label="Loading diff stats"
        data-testid="review-diff-stat-loading"
      />
    );
  }
  if (reviewDiffStat === null || (reviewDiffStat.additions === 0 && reviewDiffStat.deletions === 0)) {
    return null;
  }
  return (
    <DiffStat
      additions={reviewDiffStat.additions}
      deletions={reviewDiffStat.deletions}
      className="shrink-0"
    />
  );
}

function CommitOperand({ activeView }: { readonly activeView: ReviewViewMode | undefined }) {
  if (activeView?.operand !== "commit") return null;
  return (
    <div
      className="ml-1 flex min-w-0 items-center border-l border-border/25 pl-2"
      data-testid="review-operand-slot"
      data-operand="commit"
    >
      <CommitPicker />
    </div>
  );
}

function TurnOperand({
  activeView,
  activeThreadId,
}: {
  readonly activeView: ReviewViewMode | undefined;
  readonly activeThreadId: string | null;
}) {
  if (activeView?.operand !== "turn" || !activeThreadId) return null;
  return (
    <div
      className="ml-1 flex min-w-0 items-center border-l border-border/25 pl-2"
      data-testid="review-operand-slot"
      data-operand="turn"
    >
      <TurnPicker threadId={activeThreadId} />
    </div>
  );
}

function ReviewToolbarActions({
  activeThread,
}: {
  readonly activeThread: WorkspaceThread | null;
}) {
  return activeThread ? <ReviewActions thread={activeThread} /> : null;
}

function BranchOperand({
  activeThreadId,
  activeView,
  activeWorkspaceId,
  diffScopeRevision,
}: {
  readonly activeThreadId: string | null;
  readonly activeView: ReviewViewMode | undefined;
  readonly activeWorkspaceId: string | null;
  readonly diffScopeRevision: number;
}) {
  if (activeView?.operand !== "branch" || !activeWorkspaceId) return null;
  return (
    <div
      className="flex w-full min-w-0 basis-full items-center"
      data-testid="review-operand-slot"
      data-operand="branch"
    >
      <BranchRefPicker
        workspaceId={activeWorkspaceId}
        threadId={activeThreadId ?? undefined}
        diffScopeRevision={diffScopeRevision}
      />
    </div>
  );
}
