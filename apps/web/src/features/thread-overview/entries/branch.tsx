import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { OverviewSideMenu } from "@/features/thread-overview/overview-side-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { isDetachedCheckout, resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { MENU_ROW_CLASS } from "@/components/ui/menu-row";
import { cn } from "@/lib/utils";
import { getTransport, type Thread } from "@/transport";
import type { BranchTarget } from "@/features/conversation/composer/execution/targets/branch-target";
import type { TargetPageStatus } from "@/features/conversation/composer/execution/targets/target-page-cache";
import { useBranchTargets, useDebouncedQuery } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { Check, ChevronDown, GitBranch, GitBranchPlus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  OVERVIEW_INLINE_ACTION_CLASS,
  OVERVIEW_ROW_CLASS,
  OverviewRowIcon,
  ThreadOverviewTooltipButton,
} from "@/features/thread-overview/overview-row";

interface OverviewBranchRow {
  readonly name: string;
  readonly isCurrent: boolean;
  /** The row stands for a detached checkout, so `name` is its checkout label rather than a branch. */
  readonly detached: boolean;
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
  readonly retry: () => void;
}

function uncommittedFilesLabel(count: number): string {
  return `${count} uncommitted ${count === 1 ? "file" : "files"}`;
}

function matchesQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

function branchRows(
  targets: readonly BranchTarget[],
  currentBranch: string,
  detached: boolean,
  query: string,
): OverviewBranchRow[] {
  const localBranches = new Map<string, OverviewBranchRow>();
  for (const target of targets) {
    if (target.kind !== "branch" || target.remote !== null) continue;
    localBranches.set(target.name, { name: target.name, isCurrent: target.isCurrent, detached: false });
  }

  // The server lists real branches only; a detached checkout still gets a row, as long as the search matches it.
  if (!localBranches.has(currentBranch) && matchesQuery(currentBranch, query)) {
    localBranches.set(currentBranch, { name: currentBranch, isCurrent: true, detached });
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
      .then((result): number | null => result.status === "ready" ? result.comparison.files.length : null, () => null)
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
  // The detached row repeats the card's checkout label; a bare "HEAD" would name the same state two ways.
  const detached = isDetachedCheckout(thread);
  const displayBranch = detached ? resolveThreadCheckoutLabel(thread) : thread.branch;
  const rows = useMemo(
    () => branchRows(refs.items, displayBranch, detached, query),
    [refs.items, displayBranch, detached, query],
  );
  return { status: refs.status.kind, hasListedBranches: refs.items.length > 0, rows, uncommitted, retry: refs.retry };
}

/** Returns the current branch's uncommitted-file label. */
function getCurrentBranchUncommittedLabel(uncommittedFiles: number | null): string | null {
  if (uncommittedFiles === null || uncommittedFiles === 0) return null;
  return uncommittedFilesLabel(uncommittedFiles);
}

/**
 * Why a named checkout cannot create and switch to a new branch yet, or null when it can. A new
 * branch only helps when there is work to carry: commits ahead of the base or uncommitted files.
 */
export function createCheckoutBranchBlocker(
  uncommitted: UncommittedFilesState,
  hasCommitsAhead: boolean | null,
): string | null {
  if (!uncommitted.settled) return "Checking for changes…";
  if (hasCommitsAhead === true) return null;
  // Opening the menu re-runs the comparison, so reopening is the retry.
  if (uncommitted.count === null) return "Couldn't check for changes. Reopen this menu to retry.";
  if (uncommitted.count > 0) return null;
  // The commits-ahead check may not have answered; claim only what is known.
  return hasCommitsAhead === false ? "No commits or uncommitted changes to move" : "No uncommitted changes to move";
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
  // A detached checkout has no branch to branch from here; the card's own Create branch row owns that.
  const offersCreateBranch = thread.checkout_state === "named";

  return (
    <div
      data-testid="thread-overview-branch-popover"
      className="p-2"
    >
      {/* Matches the shared Picker's search field: the menu focuses it on open, so a ring would always show; the caret marks focus. */}
      <div className="flex h-control-compact items-center gap-2 px-3">
        <Search aria-hidden className="size-4 shrink-0 text-muted" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search branches"
          aria-label="Search branches"
          className="min-w-0 flex-1 bg-transparent text-body-small text-ink outline-none placeholder:text-muted"
        />
      </div>

      <div className="pl-9 pb-1 pt-3 text-caption text-muted">Branches</div>
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

      {offersCreateBranch ? (
        <>
          <Separator className="my-2" />
          <ThreadOverviewBranchCreateAction
            blocker={createCheckoutBranchBlocker(data.uncommitted, hasCommitsAhead)}
            onOpenChange={onOpenChange}
            onCreateBranch={onCreateBranch}
          />
        </>
      ) : null}
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
          isCurrent={branch.detached || (thread.checkout_state === "named" && (branch.name === thread.branch || branch.isCurrent))}
          headSha={thread.head_sha}
          currentBranchUncommittedLabel={currentBranchUncommittedLabel}
          onOpenChange={onOpenChange}
        />
      )) : null}
      {isEmpty ? <div className="py-2 pl-9 pr-3 text-body-small text-muted">No branches match</div> : null}
      {data.status === "failed" ? (
        <div className="py-2 pl-9 pr-3 text-body-small text-muted">
          Couldn't load branches{" "}
          <button
            type="button"
            onClick={data.retry}
            className={OVERVIEW_INLINE_ACTION_CLASS}
          >
            Retry
          </button>
        </div>
      ) : null}
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
  headSha,
  currentBranchUncommittedLabel,
  onOpenChange,
}: {
  branch: OverviewBranchRow;
  isCurrent: boolean;
  headSha: string | null | undefined;
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
      className={cn(MENU_ROW_CLASS, "h-auto min-h-row-compact justify-between border-0 py-1 font-normal", isCurrent && "bg-hover")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <GitBranch aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="min-w-0">
          {branch.detached ? (
            <span className="flex min-w-0">
              <CheckoutLabel label={branch.name} detached sha={headSha} />
            </span>
          ) : (
            <span className="block text-fade font-mono">{branch.name}</span>
          )}
          {isCurrent && currentBranchUncommittedLabel ? (
            <span className="block text-fade text-caption text-muted">
              {currentBranchUncommittedLabel}
            </span>
          ) : null}
        </span>
      </span>
      {isCurrent ? <Check className="shrink-0 text-muted" /> : null}
    </Button>
  );
}

/** Renders the branch-creation affordance for eligible checkouts. */
function ThreadOverviewBranchCreateAction({
  blocker,
  onOpenChange,
  onCreateBranch,
}: {
  blocker: string | null;
  onOpenChange: (open: boolean) => void;
  onCreateBranch: () => void;
}) {
  return (
    <ThreadOverviewTooltipButton content={blocker ?? "Create and check out branch…"} disabled={blocker !== null}>
      <Button
        variant="ghost"
        size="compact"
        type="button"
        disabled={blocker !== null}
        data-testid="thread-overview-create-checkout-branch"
        className={cn(MENU_ROW_CLASS, "justify-start border-0 font-normal disabled:opacity-60")}
        onClick={() => {
          if (blocker !== null) return;
          onOpenChange(false);
          onCreateBranch();
        }}
      >
        <GitBranchPlus aria-hidden className="size-4 shrink-0 text-muted" />
        Create and check out branch…
      </Button>
    </ThreadOverviewTooltipButton>
  );
}

/**
 * A detached checkout's label states where HEAD sits rather than naming a branch, so it reads
 * muted; only the SHA inside it is a machine fact set in mono.
 */
function CheckoutLabel({ label, detached, sha }: { label: string; detached: boolean; sha: string | null | undefined }) {
  if (!detached) return <span className="text-fade font-mono font-medium">{label}</span>;
  const shaAt = sha ? label.lastIndexOf(sha) : -1;
  if (!sha || shaAt < 0) return <span className="text-fade text-muted">{label}</span>;
  return (
    <span className="text-fade text-muted">
      {label.slice(0, shaAt)}
      <span className="font-mono">{sha}</span>
    </span>
  );
}

/** Preserves the parent-owned branch-menu choice across overview closes. */
export const { Provider: BranchEntryState, useEntryState: useBranchEntryState } = createOverviewEntryState(function useBranchMenuState() {
  return useState(false);
});

function BranchEntry({ thread }: { thread: Thread }) {
  const { branchCreation, hasCommitsAhead } = useOverviewContext();
  const [branchOpen, setBranchOpen] = useBranchEntryState();
  const branchRowRef = useRef<HTMLButtonElement>(null);
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  const detached = isDetachedCheckout(thread);
  return (
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
              <OverviewRowIcon>
                <GitBranch />
              </OverviewRowIcon>
              <CheckoutLabel label={checkoutLabel} detached={detached} sha={thread.head_sha} />
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "-mr-0.5 shrink-0 text-muted transition-transform duration-150",
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
  );
}

/** Branch block in the thread overview, preserving its existing row position. */
export function BranchEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <BranchEntry thread={subject.thread} /> : null;
}
