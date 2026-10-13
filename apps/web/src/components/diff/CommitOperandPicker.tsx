import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import { useDebouncedQuery } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { useDiffStore } from "@/stores/diffStore";
import { invalidateReviewOperandLists, pickerStatus, useCommitSearch, type SearchedCommit } from "./review-operand-lists";

/** Paper's commit picker is wider than the 320px panel so subjects have room beside the sha and time. */
const COMMIT_PANEL_CLASS = "w-[min(92vw,38rem)] p-2";

/** Format an ISO date to a compact relative string. */
function relativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  if (!isFinite(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Props for {@link CommitOperandPicker}. */
interface CommitOperandPickerProps {
  readonly workspaceId: string;
  readonly threadId?: string;
  /** Bumps when git state changes in this scope; refetches the commit lists. */
  readonly diffScopeRevision: number;
}

/**
 * The Commit view's operand: one commit from the checkout's commits since its base, searched on the server by
 * subject or sha prefix so any commit in the range is reachable. Defaults to the latest commit. Remount it per
 * scope, since the picked sha belongs to one checkout.
 */
export function CommitOperandPicker({ workspaceId, threadId, diffScopeRevision }: CommitOperandPickerProps) {
  const selectedSha = useDiffStore((s) => s.selectedCommitSha);
  const setSelectedSha = useDiffStore((s) => s.setSelectedCommitSha);
  const [open, setOpen] = usePanelHeaderMenuOpen();
  // A commit found by search can sit past the unfiltered list's loaded pages; keep its row to name it.
  const [picked, setPicked] = useState<SearchedCommit | null>(null);
  const range = useCommitSearch({ workspaceId, threadId, query: "" });
  const latest = range.items[0];

  // The picked sha belongs to the previous scope's checkout; the latest commit of this one replaces it.
  useEffect(() => {
    setSelectedSha(null);
  }, [setSelectedSha]);
  useEffect(() => {
    if (diffScopeRevision > 0) invalidateReviewOperandLists(workspaceId);
  }, [workspaceId, diffScopeRevision]);
  useEffect(() => {
    if (useDiffStore.getState().selectedCommitSha === null && latest) setSelectedSha(latest.sha);
  }, [latest, setSelectedSha]);

  const selected = range.items.find((commit) => commit.sha === selectedSha)
    ?? (picked?.sha === selectedSha ? picked : undefined);
  const empty = range.status.kind === "ready" && range.items.length === 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="commit-picker-trigger"
            disabled={empty}
            aria-label="Pick a commit"
            aria-expanded={open}
            aria-haspopup="dialog"
            className="h-8 min-w-0 max-w-[32rem] shrink justify-start gap-2 rounded-md px-2 shadow-none aria-expanded:bg-selected"
          >
            <CommitLabel commit={selected} sha={selectedSha} empty={empty} />
            <ChevronDown size={11} className="shrink-0 text-muted/65" />
          </Button>
        }
      />
      <PopoverContent align="start" side="bottom" sideOffset={4} className={COMMIT_PANEL_CLASS}>
        {open ? (
          <CommitList
            workspaceId={workspaceId}
            threadId={threadId}
            selectedSha={selectedSha}
            rangeCount={range.total}
            onPick={(commit) => {
              setPicked(commit);
              setSelectedSha(commit.sha);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CommitLabel({ commit, sha, empty }: {
  readonly commit: SearchedCommit | undefined;
  readonly sha: string | null;
  readonly empty: boolean;
}) {
  return (
    <>
      <span className="shrink-0 font-mono text-caption text-muted">
        {commit?.shortSha ?? sha?.slice(0, 7) ?? (empty ? "-" : "...")}
      </span>
      {commit ? <span className="min-w-0 text-fade text-body-small font-medium text-ink">{commit.subject}</span> : null}
    </>
  );
}

interface CommitListProps {
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly selectedSha: string | null;
  /** Commits in the whole range, from the unfiltered list. */
  readonly rangeCount: number | null;
  readonly onPick: (commit: SearchedCommit) => void;
}

/** The open picker body. Mounted only while open, so the query starts empty each time. */
function CommitList({ workspaceId, threadId, selectedSha, rangeCount, onPick }: CommitListProps) {
  const [query, setQuery] = useState("");
  const searched = useDebouncedQuery(query);
  const list = useCommitSearch({ workspaceId, threadId, query: searched });
  const renderRow = (commit: SearchedCommit): PickerRow => ({
    key: commit.sha,
    prefix: commit.shortSha,
    name: commit.subject,
    tag: relativeTime(commit.date),
  });
  return (
    <Picker
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search commits"
      items={list.items}
      total={list.total}
      countLabel={countLabel(searched, list.total, rangeCount)}
      onLoadMore={list.loadMore}
      status={pickerStatus(list.status)}
      onRetry={list.retry}
      selectedKey={selectedSha ?? undefined}
      renderItem={renderRow}
      onSelect={onPick}
    />
  );
}

/** "4 matches in 412 commits" while searching; the range size otherwise. */
function countLabel(query: string, matches: number | null, rangeCount: number | null): string | undefined {
  if (rangeCount === null) return undefined;
  const commits = `${rangeCount} ${rangeCount === 1 ? "commit" : "commits"}`;
  if (query === "") return commits;
  if (matches === null) return undefined;
  return `${matches} ${matches === 1 ? "match" : "matches"} in ${commits}`;
}
