import type { ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import { openGitHubUrl } from "@/features/preview/navigation/open-url-in-preview";
import { getPullRequestStateVisual } from "@/lib/pr-status";
import { cn } from "@/lib/utils";

interface PullRequestChipProps {
  readonly threadId: string;
  /** The thread's PRs, highest-ranked first. */
  readonly ranked: readonly ThreadPullRequest[];
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly dimmed: boolean;
}

function stopRowEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

function openPullRequest(pr: ThreadPullRequest, threadId: string, event: React.MouseEvent): void {
  event.stopPropagation();
  if (pr.url) openGitHubUrl(pr.url, threadId, event);
}

function StateIcon({ pr }: { pr: ThreadPullRequest }) {
  const { Icon, color } = getPullRequestStateVisual(pr.state);
  return <Icon size={13} aria-hidden className={cn("shrink-0", color)} />;
}

const CHIP_CLASS = "flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-caption tabular-nums text-muted outline-none transition-colors hover:bg-selected/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70";

/** Opens a single PR or toggles the ranked list when several PRs are linked. */
export function PullRequestChip({ threadId, ranked, expanded, onToggleExpanded, dimmed }: PullRequestChipProps) {
  const [primary] = ranked;
  if (!primary) return null;
  const common = { onPointerDown: stopRowEvent, onKeyDown: stopRowEvent, onDoubleClick: stopRowEvent, "data-testid": `thread-pr-indicator-${threadId}` };
  if (ranked.length > 1) {
    return (
      <button
        type="button"
        {...common}
        aria-label={`${ranked.length} pull requests`}
        aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpanded();
        }}
        className={cn(CHIP_CLASS, expanded && "bg-selected/60", dimmed && "grayscale opacity-45")}
      >
        <StateIcon pr={primary} />+{ranked.length - 1}
      </button>
    );
  }
  return (
    <button
      type="button"
      {...common}
      aria-label={`PR #${primary.number}, ${primary.state}`}
      disabled={primary.url === null}
      onClick={(event) => openPullRequest(primary, threadId, event)}
      className={cn(CHIP_CLASS, "disabled:cursor-default disabled:hover:bg-transparent", dimmed && "grayscale opacity-45")}
    >
      <StateIcon pr={primary} />
      {primary.number}
    </button>
  );
}

/** The expanded list under a row with several PRs, in rank order. Each entry opens its PR. */
export function PullRequestList({ threadId, ranked }: { threadId: string; ranked: readonly ThreadPullRequest[] }) {
  return (
    <div role="list" aria-label="Pull requests" className="-ml-1 flex flex-col">
      {ranked.map((pr) => (
        <div role="listitem" key={pr.number}>
          <button
            type="button"
            aria-label={`${pr.title ?? `PR #${pr.number}`}, PR #${pr.number}, ${pr.state}`}
            disabled={pr.url === null}
            onPointerDown={stopRowEvent}
            onKeyDown={stopRowEvent}
            onDoubleClick={stopRowEvent}
            onClick={(event) => openPullRequest(pr, threadId, event)}
            className="flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-caption text-muted outline-none transition-colors hover:bg-selected/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70 disabled:cursor-default"
          >
            <StateIcon pr={pr} />
            <span className="text-fade min-w-0 flex-1">{pr.title ?? `PR #${pr.number}`}</span>
            <span className="shrink-0 tabular-nums">{pr.number}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
