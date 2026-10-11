import type { ThreadStartup } from "@mcode/contracts";
import type { StatusMarkState } from "@/components/ui/status-mark";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { startupDecision } from "@/features/thread-startup/startup-step-copy";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
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

/** Only a setup that is holding the thread's startup shapes its row. */
export function threadRowSetup(startup: ThreadStartup | undefined): ThreadRowSetup {
  switch (startupDecision(startup)) {
    case "setup-approval":
      return "awaiting-approval";
    case "setup-failed":
      return "failed";
    default:
      return startup?.steps.some((step) => step.phase === "setup" && step.state === "running") ? "running" : null;
  }
}

/** The startup maps a row reads its setup from, as held by the thread startup store. */
export type ThreadStartupMaps = Pick<ReturnType<typeof useThreadStartupStore.getState>, "recordsByStartupId" | "startupIdByThreadId">;

/** A thread's startup record, if this client has one. */
export function threadStartupRecord(state: ThreadStartupMaps, threadId: string): ThreadStartup | undefined {
  const startupId = state.startupIdByThreadId[threadId];
  return startupId ? state.recordsByStartupId[startupId] : undefined;
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
  const setup = useThreadStartupStore((state) => threadRowSetup(threadStartupRecord(state, threadId)));
  return deriveThreadRowState({ attention, running: executing || startupPending || preparing, setup, onScreen });
}

/** Reads a thread's row state outside React from the same facts as {@link useThreadRowState}. */
export function readThreadRowState(threadId: string, preparing = false): ThreadRowState {
  const { byThreadId, onScreenThreadId } = threadAttentionStore.getState();
  const startupPending = useWorkspaceStore.getState().pendingStartupByThreadId[threadId] !== undefined;
  return deriveThreadRowState({
    attention: byThreadId[threadId],
    running: isThreadExecuting(threadId, useThreadStore.getState()) || startupPending || preparing,
    setup: threadRowSetup(threadStartupRecord(useThreadStartupStore.getState(), threadId)),
    onScreen: onScreenThreadId === threadId,
  });
}
