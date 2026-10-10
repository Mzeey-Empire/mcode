import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { OverviewSideMenu } from "@/features/thread-overview/overview-side-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { cn } from "@/lib/utils";
import { getTransport, type Thread } from "@/transport";
import type { BranchTarget } from "@/features/conversation/composer/execution/targets/branch-target";
import type { TargetPageStatus } from "@/features/conversation/composer/execution/targets/target-page-cache";
import { useBranchTargets, useDebouncedQuery } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { Check, ChevronDown, GitBranch, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  OVERVIEW_ROW_CLASS,
  ThreadOverviewTooltipButton,
  ThreadOverviewWhen,
} from "@/features/thread-overview/overview-row";

interface OverviewBranchRow {
  readonly name: string;
  readonly isCurrent: boolean;
}

interface UncommittedFilesState {
  /** False until the comparison answers or fails; branch creation waits for it. */
  readonly settled: boolean;
  readonly count: number | null;
}

interface BranchMenuData {
  readonly status: TargetPageStatus<unknown>["kind"];
  readonly hasListedBranches: boolean;
  readonly rows: readonly OverviewBranchRow[];
  readonly uncommitted: UncommittedFilesState;
}

function uncommittedFilesLabel(count: number): string {
  return `Uncommitted: ${count} ${count === 1 ? "file" : "files"}`;
}

function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

function branchRows(targets: readonly BranchTarget[], currentBranch: string, query: string): OverviewBranchRow[] {
  const localBranches = new Map<string, OverviewBranchRow>();
  for (const target of targets) {
    if (target.kind !== "branch" || target.remote !== null) continue;
    localBranches.set(target.name, { name: target.name, isCurrent: target.isCurrent });
  }

  // The server lists real branches only; a branchless checkout's HEAD still gets a row, as long as the search matches it.
  if (!localBranches.has(currentBranch) && matchesQuery(currentBranch, query)) {
    localBranches.set(currentBranch, { name: currentBranch, isCurrent: true });
  }

  return [...localBranches.values()].sort((a, b) => {
    if (a.name === currentBranch) return -1;
    if (b.name === currentBranch) return 1;
    return a.name.localeCompare(b.name);
  });
}

interface ThreadOverviewBranchMenuProps {
  thread: Thread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateBranch: () => void;
  hasCommitsAhead: boolean | null;
}

/** Counts the checkout's uncommitted files while the branch picker is open. */
function useUncommittedFiles(thread: Thread, open: boolean): UncommittedFilesState {
  const [uncommitted, setUncommitted] = useState<UncommittedFilesState>({ settled: false, count: null });

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    // A failed comparison only hides the count; the branch list stays usable.
    void getTransport()
      .getReviewComparison({ workspaceId: thread.workspace_id, view: "uncommitted", threadId: thread.id })
      .then((comparison): number | null => comparison.files.length, () => null)
      .then((count) => {
        if (!cancelled) setUncommitted({ settled: true, count });
      });

    return () => {
      cancelled = true;
    };
  }, [open, thread.id, thread.workspace_id]);

  return uncommitted;
}

/** Lists the checkout's local branches, searched on the server, while the branch picker is open. */
function useThreadOverviewBranchData(thread: Thread, open: boolean, search: string): BranchMenuData {
  const query = useDebouncedQuery(search);
  const refs = useBranchTargets(open
    ? { workspaceId: thread.workspace_id, threadId: thread.id, purpose: "new-thread", query }
    : null);
  const uncommitted = useUncommittedFiles(thread, open);
  const displayBranch = thread.checkout_state === "branchless" ? "HEAD" : thread.branch;
  const rows = useMemo(() => branchRows(refs.items, displayBranch, query), [refs.items, displayBranch, query]);
  return { status: refs.status.kind, hasListedBranches: refs.items.length > 0, rows, uncommitted };
}

/** Returns the current branch's uncommitted-file label. */
function getCurrentBranchUncommittedLabel(uncommittedFiles: number | null): string | null {
  if (uncommittedFiles === null || uncommittedFiles === 0) return null;
  return uncommittedFilesLabel(uncommittedFiles);
}

/** Returns whether this checkout can create and switch to a new branch. */
function canCreateCheckoutBranch(
  thread: Thread,
  uncommitted: UncommittedFilesState,
  hasCommitsAhead: boolean | null,
): boolean {
  if (thread.checkout_state !== "named" || !uncommitted.settled) return false;
  if (hasCommitsAhead === true) return true;
  return uncommitted.count !== null && uncommitted.count > 0;
}

function ThreadOverviewBranchMenu({
  thread,
  open,
  onOpenChange,
  onCreateBranch,
  hasCommitsAhead,
}: ThreadOverviewBranchMenuProps) {
  const [search, setSearch] = useState("");
  const data = useThreadOverviewBranchData(thread, open, search);

  const currentBranchUncommittedLabel = getCurrentBranchUncommittedLabel(data.uncommitted.count);
  const shouldConstrainBranchList = data.rows.length > 6;
  const canCreateNewBranch = canCreateCheckoutBranch(thread, data.uncommitted, hasCommitsAhead);

  return (
    <div
      data-testid="thread-overview-branch-popover"
      className="p-2"
    >
      <div className="relative">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
        />
        <Input
          size="compact"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search branches"
          aria-label="Search branches"
          className="h-7 pl-7"
        />
      </div>

      <div className="px-1 pb-1 pt-3 text-xs text-muted">Branches</div>
      <ScrollArea
        data-testid="thread-overview-branch-list"
        className={cn(shouldConstrainBranchList && "h-60")}
      >
        <ThreadOverviewBranchRows
          thread={thread}
          data={data}
          currentBranchUncommittedLabel={currentBranchUncommittedLabel}
          onOpenChange={onOpenChange}
        />
      </ScrollArea>

      <Separator className="my-2" />
      <ThreadOverviewBranchCreateAction
        canCreateCheckoutBranch={canCreateNewBranch}
        onOpenChange={onOpenChange}
        onCreateBranch={onCreateBranch}
      />
    </div>
  );
}

/** Renders loaded branches and their branch-picker states. */
function ThreadOverviewBranchRows({
  thread,
  data,
  currentBranchUncommittedLabel,
  onOpenChange,
}: {
  thread: Thread;
  data: BranchMenuData;
  currentBranchUncommittedLabel: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const showBranches = data.status !== "loading" || data.hasListedBranches;
  const isEmpty = data.status !== "loading" && data.rows.length === 0;

  return (
    <div className="space-y-0.5 pr-2">
      {showBranches ? null : <ThreadOverviewBranchLoadingRow />}
      {showBranches ? data.rows.map((branch) => (
        <ThreadOverviewBranchRow
          key={branch.name}
          branch={branch}
          isCurrent={thread.checkout_state === "named" && (branch.name === thread.branch || branch.isCurrent)}
          currentBranchUncommittedLabel={currentBranchUncommittedLabel}
          onOpenChange={onOpenChange}
        />
      )) : null}
      {isEmpty ? <div className="rounded-md px-2 py-2 text-xs text-muted">No branches match</div> : null}
      {data.status === "failed" ? <div className="rounded-md px-2 py-2 text-xs text-muted">Branches unavailable</div> : null}
    </div>
  );
}

/** Renders the branch-picker loading placeholder. */
function ThreadOverviewBranchLoadingRow() {
  return <div className="animate-thread-overview-loading h-8 overflow-hidden rounded-md bg-hover/35" aria-hidden />;
}

/** Renders one branch row in the branch picker. */
function ThreadOverviewBranchRow({
  branch,
  isCurrent,
  currentBranchUncommittedLabel,
  onOpenChange,
}: {
  branch: OverviewBranchRow;
  isCurrent: boolean;
  currentBranchUncommittedLabel: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      onClick={() => {
        if (isCurrent) onOpenChange(false);
      }}
      aria-current={isCurrent ? "true" : undefined}
      data-testid={isCurrent ? "thread-overview-current-branch" : undefined}
      className={cn("h-auto w-full justify-between gap-3 px-2 py-1.5 text-left", isCurrent && "bg-hover text-ink")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block text-fade text-xs font-medium">{branch.name}</span>
          {isCurrent && currentBranchUncommittedLabel ? (
            <span className="block text-fade text-xs font-normal text-muted">
              {currentBranchUncommittedLabel}
            </span>
          ) : null}
        </span>
      </span>
      {isCurrent ? <Check size={14} className="shrink-0 text-muted" /> : null}
    </Button>
  );
}

/** Renders the branch-creation affordance for eligible checkouts. */
function ThreadOverviewBranchCreateAction({
  canCreateCheckoutBranch,
  onOpenChange,
  onCreateBranch,
}: {
  canCreateCheckoutBranch: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateBranch: () => void;
}) {
  const title = canCreateCheckoutBranch
    ? "Create and checkout a new branch"
    : "Detected changes required";

  return (
    <ThreadOverviewTooltipButton content={title} disabled={!canCreateCheckoutBranch}>
      <Button
        variant="ghost"
        size="compact"
        type="button"
        disabled={!canCreateCheckoutBranch}
        data-testid="thread-overview-create-checkout-branch"
        className="h-8 w-full justify-start gap-2 px-2 text-xs disabled:opacity-60"
        onClick={() => {
          if (!canCreateCheckoutBranch) return;
          onOpenChange(false);
          onCreateBranch();
        }}
      >
        <Plus size={14} className="text-muted" />
        Create and checkout new branch...
      </Button>
    </ThreadOverviewTooltipButton>
  );
}

/** Preserves the parent-owned branch-menu choice across overview closes. */
export const { Provider: BranchEntryState, useEntryState: useBranchEntryState } = createOverviewEntryState(function useBranchMenuState() {
  return useState(false);
});

function BranchEntry({ thread }: { thread: Thread }) {
  const { branchCreation, branchlessCreatePr, hasCommitsAhead } = useOverviewContext();
  const [branchOpen, setBranchOpen] = useBranchEntryState();
  const branchRowRef = useRef<HTMLButtonElement>(null);
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  return (<ThreadOverviewWhen when={!branchlessCreatePr}>
    <Popover open={branchOpen} onOpenChange={setBranchOpen}>
      <PopoverTrigger
        ref={branchRowRef}
        render={
          <Button
            variant="ghost"
            size="compact"
            type="button"
            data-testid="workspace-menu-branch"
            className={cn(
              OVERVIEW_ROW_CLASS,
              "justify-between",
              branchOpen && "bg-hover text-ink",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <GitBranch
                size={14}
                className="shrink-0 text-muted transition-colors duration-150 group-hover:text-ink/80"
              />
              <span className="text-fade text-xs font-medium">{checkoutLabel}</span>
            </span>
            <ChevronDown
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-muted transition-transform duration-150",
                branchOpen && "rotate-180",
              )}
            />
          </Button>
        }
      />
      <OverviewSideMenu rowRef={branchRowRef} className="w-72">
        <ThreadOverviewBranchMenu
          thread={thread}
          open={branchOpen}
          onOpenChange={setBranchOpen}
          onCreateBranch={() => branchCreation.setOpen(true)}
          hasCommitsAhead={hasCommitsAhead}
        />
      </OverviewSideMenu>
    </Popover>
  </ThreadOverviewWhen>);
}

/** Branch block in the thread overview, preserving its existing row position. */
export function BranchEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <BranchEntry thread={subject.thread} /> : null;
}
