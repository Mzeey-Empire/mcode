import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import type { StatusMarkState } from "@/components/ui/status-mark";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
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
export function threadRowSetup(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): ThreadRowSetup {
  if (snapshot.gate !== "blocked") return null;
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

/** Subscribes a row to the facts that pick its state. */
export function useThreadRowState(threadId: string, setup: ThreadRowSetup = null): ThreadRowState {
  const attention = threadAttentionStore((state) => state.byThreadId[threadId]);
  const onScreen = threadAttentionStore((state) => state.onScreenThreadId === threadId);
  const running = useThreadStore((state) => isThreadExecuting(threadId, state));
  return deriveThreadRowState({ attention, running, setup, onScreen });
}
