import { useCallback } from "react";
import { PanelRight } from "lucide-react";
import { OpenInAppButton } from "./OpenInAppButton";
import { ThreadOverview } from "./ThreadOverview";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resolveThreadDirPath } from "@/lib/worktree";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import type { Thread } from "@/transport";
/** Props for {@link HeaderActions}. */
interface HeaderActionsProps {
  thread: Thread;
  /** Current width of the chat pane that owns the composer and thread timeline. */
  threadPaneWidth: number;
}

/**
 * Renders the chat-header action strip: open-in, thread Overview, and the
 * workspace-global right-panel toggle.
 */
export function HeaderActions({ thread, threadPaneWidth }: HeaderActionsProps) {
  const workspacePath = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id)?.path ?? null,
  );

  // Effective open/closed state for the workspace-global right panel.
  const panelVisible = useDiffStore((s) =>
    thread.workspace_id
      ? s.getRightPanelVisible(thread.workspace_id, thread.id)
      : false,
  );

  const togglePanel = useCallback(() => {
    if (!thread.workspace_id) return;
    toggleRightPanelAdaptive(thread.workspace_id, thread.id);
  }, [thread.workspace_id, thread.id]);

  // Live keycap for the right-panel toggle, shown in the button's tooltip.
  const panelShortcut = keybindingKeycaps(
    getKeybindingForCommand("rightPanel.toggle")?.key ?? "mod+alt+b",
    isMac,
  );

  return (
    <div className="flex items-center justify-end gap-1">
      <div className="flex items-center gap-0.5 bg-hover/20 rounded-md px-1 py-0.5">
        <OpenInAppButton
          dirPath={resolveThreadDirPath(thread, workspacePath)}
          threadId={thread.id}
          threadOverride={thread.default_open_in_app ?? null}
        />
      </div>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <ThreadOverview thread={thread} threadPaneWidth={threadPaneWidth} />

      {/* Dedicated right-panel toggle for the workspace-global panel. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              onClick={togglePanel}
              aria-label="Toggle panel"
              aria-pressed={panelVisible}
              data-testid="header-panel-toggle"
              className={
                panelVisible
                  ? "cursor-pointer text-ink bg-hover/40"
                  : "cursor-pointer text-ink/70 hover:text-ink hover:bg-hover/40"
              }
            >
              <PanelRight size={14} />
            </Button>
          }
        />
        <TooltipContent side="bottom" shortcut={panelShortcut}>
          Toggle panel
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
