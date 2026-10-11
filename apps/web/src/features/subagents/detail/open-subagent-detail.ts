import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { clearSubagentDetail, selectSubagentDetail } from "../state";

/** Opens the active thread's Subagents panel. */
export function openSubagentsPanel(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;

  const diff = useDiffStore.getState();
  diff.setRightPanelTab(activeWorkspaceId, activeThreadId, "subagents");
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  return true;
}

/** Clears the active child detail and opens the active thread's Subagents list. */
export function openSubagentsRoster(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;

  clearSubagentDetail(activeThreadId);
  return openSubagentsPanel();
}

/** Opens one child detail in the active thread's Subagents panel. */
export function openSubagentDetail(id: string): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId || id.length === 0) return false;

  selectSubagentDetail(activeThreadId, { id, scrollTop: 0 });
  return openSubagentsPanel();
}
