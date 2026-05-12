import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useActionStore } from "@/stores/actionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { ActionDropdown } from "./ActionDropdown";
import { getLucideIcon } from "@/lib/action-icons";

/** Duration in ms that the spinner replaces the action icon after a run is triggered. */
const RUN_SPINNER_MS = 600;

/**
 * Split-click header button for running project actions.
 *
 * Left-clicking the body runs the last-used action (or the first defined action when no
 * history exists). Clicking the chevron opens a dropdown listing all actions.
 * Hidden entirely when the workspace has no actions configured.
 */
export function ActionTrigger() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);

  const actions = useActionStore(
    (s) => s.actionsByWorkspace[activeWorkspaceId ?? ""] ?? [],
  );
  const lastUsedId = useActionStore(
    (s) => s.lastUsedByWorkspace[activeWorkspaceId ?? ""],
  );
  const loadActions = useActionStore((s) => s.loadActions);
  const runAction = useActionStore((s) => s.runAction);

  const [running, setRunning] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load actions whenever the active workspace changes.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    loadActions(activeWorkspaceId);
  }, [activeWorkspaceId, loadActions]);

  // Clear the spinner timer on unmount to avoid state updates on an unmounted component.
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
    };
  }, []);

  if (!activeWorkspaceId || actions.length === 0) return null;

  const lastUsed = lastUsedId
    ? actions.find((a) => a.id === lastUsedId)
    : undefined;
  const action = lastUsed ?? actions[0]!;

  const hasThread = activeThreadId != null;
  const disabledReason = hasThread ? undefined : "Open a thread to run actions";

  const ActionIcon = getLucideIcon(action.icon);

  function handleRun() {
    if (!hasThread || !activeWorkspaceId || running) return;
    setRunning(true);
    void runAction(activeWorkspaceId, action.id, activeThreadId!);
    timerRef.current = setTimeout(() => setRunning(false), RUN_SPINNER_MS);
  }

  const bodyButton = (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleRun}
      aria-disabled={!hasThread}
      className={cn(
        "gap-1 text-xs h-6 rounded-r-none text-foreground/70 hover:text-foreground hover:bg-muted/40",
        !hasThread && "opacity-50 pointer-events-auto cursor-not-allowed",
      )}
      aria-label={`Run ${action.name}`}
    >
      {running ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <ActionIcon size={12} />
      )}
      {/* Hide label at narrow widths; icon + chevron alone is sufficient at xs. */}
      <span className="hidden sm:inline">{action.name}</span>
    </Button>
  );

  return (
    <div className="flex items-center gap-0.5 bg-muted/20 rounded-md px-1 py-0.5">
      <div className="inline-flex">
        <Tooltip>
          <TooltipTrigger render={bodyButton} />
          <TooltipContent side="bottom" className="text-xs">
            {disabledReason ?? `Run ${action.name}`}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger
            aria-label="Open actions menu"
            className="inline-flex items-center px-1.5 h-6 text-xs border-l border-border/20 rounded-r transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring text-foreground/70 hover:text-foreground hover:bg-muted/40"
          >
            <ChevronDown
              size={10}
              className={cn("transition-transform duration-150", dropdownOpen && "rotate-180")}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4}>
            <ActionDropdown onClose={() => setDropdownOpen(false)} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
