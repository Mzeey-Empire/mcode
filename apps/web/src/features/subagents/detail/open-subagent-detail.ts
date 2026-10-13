import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** Opens the active thread's Subagents list. */
export function openSubagentsPanel(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;

  useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "subagents");
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  return true;
}

/** Opens one roster entry as its own rail tab in the active thread's panel. */
export function openSubagentDetail(id: string): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId || id.length === 0) return false;

  useDiffStore.getState().openSubagentTab(activeWorkspaceId, activeThreadId, id);
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  return true;
}
