import { useEffect } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";

/**
 * Opens the Plan panel when the user switches to a thread whose plan is ready.
 * Reads the phase at switch time instead of subscribing to it, so a plan that
 * becomes ready under the user's eyes stays behind the overview row.
 */
export function useOpenPlanWhenReady(threadId: string | null): void {
  useEffect(() => {
    if (!threadId) return;
    const thread = useWorkspaceStore.getState().threads.find((candidate) => candidate.id === threadId);
    if (thread?.plan_phase !== "ready") return;
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "tasks");
  }, [threadId]);
}
