import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";
import { cn } from "@/lib/utils";
import { type Thread } from "@/transport";
import { Check, ChevronDown, Copy, Laptop } from "lucide-react";
import { useCallback, useState } from "react";
import { OVERVIEW_ROW_CLASS } from "@/features/thread-overview/overview-row";

type LocalCopyTarget = "path" | "branch";

/** Formats the local-checkout row label for assistive technology. */
function localCheckoutAriaLabel(modeLabel: string, dirPath: string | null): string {
  return dirPath ? `${modeLabel}, ${dirPath}` : modeLabel;
}

/** Returns the label and icon for the active thread checkout mode. */
function getThreadOverviewLocalMode(thread: Thread) {
  if (thread.mode === "worktree") return { label: "Worktree", Icon: WorktreeModeIcon };
  return { label: "Direct", Icon: Laptop };
}

interface ThreadOverviewLocalMenuProps {
  worktreePath: string | null;
  branch: string;
}

function ThreadOverviewLocalMenu({ worktreePath, branch }: ThreadOverviewLocalMenuProps) {
  const [copied, setCopied] = useState<LocalCopyTarget | null>(null);

  const copyValue = useCallback(async (target: LocalCopyTarget, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1500);
  }, []);

  return (
    <div data-testid="thread-overview-local-popover" className="animate-popover-enter p-2">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-ink">Worktree path</span>
            <span
              data-testid="thread-overview-local-path"
              className="block max-w-56 text-fade font-mono text-xs text-muted"
            >
              {worktreePath ?? "Unavailable"}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy worktree path"
            disabled={!worktreePath}
            onClick={() => {
              if (worktreePath) void copyValue("path", worktreePath);
            }}
            className="shrink-0"
          >
            {copied === "path" ? <Check size={13} /> : <Copy size={13} />}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-ink">Branch</span>
            <span
              data-testid="thread-overview-local-branch"
              className="block max-w-56 text-fade font-mono text-xs text-muted"
            >
              {branch}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy branch"
            onClick={() => void copyValue("branch", branch)}
            className="shrink-0"
          >
            {copied === "branch" ? <Check size={13} /> : <Copy size={13} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Preserves the parent-owned local-menu choice across overview closes. */
export const { Provider: LocalEntryState, useEntryState: useLocalEntryState } = createOverviewEntryState(function useLocalMenuState() {
  return useState(false);
});

function LocalEntry({ thread }: { thread: Thread }) {
  const { dirPath } = useOverviewContext();
  const [localOpen, setLocalOpen] = useLocalEntryState();
  const { label: modeLabel, Icon: LocalModeIcon } = getThreadOverviewLocalMode(thread);
  const checkoutLabel = resolveThreadCheckoutLabel(thread);
  return (<Popover open={localOpen} onOpenChange={setLocalOpen}>
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="thread-overview-local"
          aria-label={localCheckoutAriaLabel(modeLabel, dirPath)}
          className={cn(
            OVERVIEW_ROW_CLASS,
            "justify-between",
            localOpen && "bg-hover text-ink",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <LocalModeIcon
              size={14}
              aria-hidden
              data-testid="thread-overview-local-mode-icon"
              className="shrink-0 text-muted transition-colors duration-150 group-hover:text-ink/80"
            />
            <span className="text-fade text-xs font-medium">{modeLabel}</span>
          </span>
          <ChevronDown
            size={13}
            aria-hidden
            className={cn(
              "shrink-0 text-muted transition-transform duration-150",
              localOpen && "rotate-180",
            )}
          />
        </Button>
      }
    />
    <PopoverContent
      align="start"
      side="left"
      sideOffset={12}
      className="w-80 p-0"
    >
      <ThreadOverviewLocalMenu worktreePath={dirPath} branch={checkoutLabel} />
    </PopoverContent>
  </Popover>);
}

/** Local block in the thread overview, preserving its existing row position. */
export function LocalEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <LocalEntry thread={subject.thread} /> : null;
}
