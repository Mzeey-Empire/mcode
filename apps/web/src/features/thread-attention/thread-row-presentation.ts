import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import type { StatusMarkState } from "@/components/ui/status-mark";
import { useProjectAutomaticSetupStore } from "@/features/projects/environment";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "./thread-attention-store";
import { deriveThreadRowState, type ThreadRowSetup, type ThreadRowState } from "./thread-row-state";

/** How a row state renders: its status lane mark and, when it has one, its third-line label. */
export interface ThreadRowLook {
  mark: { state: StatusMarkState; label: string } | null;
  label: { text: string; className: string } | null;
}

/** Maps a row state to its status lane mark and third line. Running rows fade through `data-status-mark`. */
export function threadRowLook(state: ThreadRowState): ThreadRowLook {
  switch (state.kind) {
    case "needs-you":
      return {
        mark: { state: "attention", label: state.label },
        label: { text: state.label, className: "text-primary" },
      };
    case "running":
      return { mark: { state: "running", label: "Running" }, label: null };
    case "failed":
      return { mark: { state: "error", label: "Failed" }, label: { text: "Failed", className: "text-error" } };
    case "finished":
      return { mark: { state: "success", label: "Finished" }, label: { text: "Finished", className: "text-success" } };
    case "quiet":
      return { mark: null, label: null };
  }
}

/** Only a setup that is gating the thread shapes its row. */
export function threadRowSetup(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot | undefined): ThreadRowSetup {
  if (snapshot?.gate !== "blocked") return null;
  switch (snapshot.attempt?.state) {
    case "queued":
    case "running":
      return "running";
    case "awaiting-approval":
      return "awaiting-approval";
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return null;
  }
}

/**
 * Subscribes a row to the facts that pick its state. Every surface reads setup
 * and startup from the shared stores, so a palette result, an expanded row and
 * a collapsed project roll-up never disagree about one thread.
 */
export function useThreadRowState(threadId: string, preparing = false): ThreadRowState {
  const attention = threadAttentionStore((state) => state.byThreadId[threadId]);
  const onScreen = threadAttentionStore((state) => state.onScreenThreadId === threadId);
  const executing = useThreadStore((state) => isThreadExecuting(threadId, state));
  const startupPending = useWorkspaceStore((state) => state.pendingStartupByThreadId[threadId] !== undefined);
  const setup = useProjectAutomaticSetupStore((state) => threadRowSetup(state.snapshotsByThread[threadId]));
  return deriveThreadRowState({ attention, running: executing || startupPending || preparing, setup, onScreen });
}
