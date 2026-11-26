import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { registerCommand } from "@/lib/command-registry";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { summonTab } from "@/lib/summon-tab";
import { useDiffStore } from "@/stores/diffStore";

/** Registers Open Project Settings and Toggle Changes Panel and returns their unregister function. */
export function registerProjectOnlyCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "projectEnvironment.open",
      title: "Open Project Settings",
      category: "Project",
      projectOnly: true,
      handler: () => {
        const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
        if (!activeWorkspaceId) return;
        showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
        useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "environment");
      },
    }),
    registerCommand({
      id: "changes.toggle",
      title: "Toggle Changes Panel",
      category: "View",
      projectOnly: true,
      handler: () => summonTab("changes"),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
