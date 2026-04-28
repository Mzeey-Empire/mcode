import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { PathLabel } from "./PathLabel";
import { useProjectSelectorStore } from "@/stores/projectSelectorStore";

/** Props for ProjectRow. */
interface Props {
  /** Workspace data for this row. */
  workspace: {
    id: string;
    name: string;
    path: string;
    pinned: boolean;
    last_opened_at: number | null;
    is_git_repo: boolean;
  };
  /** Whether this row is the currently active (keyboard-focused) item. */
  isActive?: boolean;
  /** Called when the user clicks the row to open the workspace. */
  onSelect: (id: string) => void;
  /** Called when the user toggles the pin state. Second argument is the desired new pinned value. */
  onPin: (id: string, pinned: boolean) => void;
  /** Called when the user removes the workspace from recents. Optional — row hides the button if absent. */
  onRemove?: (id: string) => void;
  /** Home directory prefix used by PathLabel to collapse the path to ~. */
  home?: string;
}

/** Format a unix timestamp (ms) as a short relative time string (e.g. "2h ago", "3d ago"). */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

/**
 * One row in the project selector list.
 * Lazy enrichment (branch, clean state, thread count) fades in from projectSelectorStore
 * as the RPC resolves. Pin and remove actions are callbacks to keep optimistic updates
 * in the parent.
 */
export function ProjectRow({ workspace, isActive, onSelect, onPin, onRemove, home }: Props) {
  const enrichment = useProjectSelectorStore((s) => s.enrichmentCache.get(workspace.id));
  const enrich = useProjectSelectorStore((s) => s.enrich);

  // Kick off enrichment when the row mounts so meta appears as fast as possible.
  useEffect(() => {
    enrich([workspace.id]);
  }, [workspace.id, enrich]);

  return (
    <div
      role="option"
      aria-selected={isActive}
      data-active={isActive}
      data-testid="project-row"
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-[13px] transition-colors",
        "hover:bg-accent/60 data-[active=true]:bg-accent",
      )}
      onClick={() => onSelect(workspace.id)}
    >
      {/* Left: name + path */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{workspace.name}</span>
          {/* Pin toggle — always visible when pinned, shown on hover otherwise */}
          <button
            data-testid="project-row-pin"
            className="ml-1 shrink-0 text-[12px] text-primary/70 opacity-0 transition-opacity group-hover:opacity-100 data-[pinned=true]:opacity-100"
            data-pinned={workspace.pinned}
            onClick={(e) => {
              e.stopPropagation();
              onPin(workspace.id, !workspace.pinned);
            }}
            aria-label={workspace.pinned ? "Unpin" : "Pin"}
          >
            {workspace.pinned ? "★" : "☆"}
          </button>
        </div>
        <PathLabel path={workspace.path} home={home} />
      </div>

      {/* Right: meta strip — branch, status dot, thread count, relative timestamp */}
      <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] text-muted-foreground/60">
        {enrichment ? (
          <>
            <div className="flex items-center gap-1.5">
              {enrichment.isGit ? (
                <>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      enrichment.isClean ? "bg-green-600/70" : "bg-amber-600/70",
                    )}
                  />
                  <span>⎇ {enrichment.branch ?? "detached"}</span>
                  {enrichment.threadCount > 0 && (
                    <span className="tabular-nums">· {enrichment.threadCount}</span>
                  )}
                </>
              ) : (
                // Non-git workspace indicator in mono small-caps style
                <span className="uppercase tracking-[0.14em] text-muted-foreground/40">⊘ no git</span>
              )}
            </div>
            {workspace.last_opened_at && (
              <span className="tabular-nums">{relativeTime(workspace.last_opened_at)}</span>
            )}
          </>
        ) : (
          // Show timestamp as skeleton while enrichment is loading
          workspace.last_opened_at && (
            <span className="tabular-nums">{relativeTime(workspace.last_opened_at)}</span>
          )
        )}
      </div>

      {/* Remove from recents — only shown when handler is provided */}
      {onRemove && (
        <button
          data-testid="project-row-remove"
          className="shrink-0 text-[11px] text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(workspace.id);
          }}
          aria-label="Remove from recents"
          title="Remove from recents (Ctrl+Backspace)"
        >
          ✕
        </button>
      )}
    </div>
  );
}
