import { useCallback } from "react";
import { PanelRight } from "lucide-react";
import { OpenInAppButton } from "./OpenInAppButton";
import { ThreadOverview } from "./ThreadOverview";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resolveThreadDirPath } from "@/lib/worktree";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { IconButton } from "@/components/ui/button";
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
 * Renders the chat-header action strip as Paper draws it: the open-in pill, then round
 * thread Overview and workspace-global right-panel buttons.
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
    <div className="flex items-center justify-end gap-2">
      <OpenInAppButton
        dirPath={resolveThreadDirPath(thread, workspacePath)}
        threadId={thread.id}
        threadOverride={thread.default_open_in_app ?? null}
      />

      <ThreadOverview thread={thread} threadPaneWidth={threadPaneWidth} />

      {/* While open, the panel header owns this toggle at the same spot. */}
      {panelVisible ? null : (
        <IconButton
          shape="round"
          onClick={togglePanel}
          aria-label="Toggle panel"
          tooltipShortcut={panelShortcut}
          data-testid="header-panel-toggle"
        >
          <PanelRight size={16} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}
