import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import { CircleAlert, CircleCheck, CirclePause, ListChecks, MessageCircleQuestion, ShieldAlert, type LucideIcon } from "lucide-react";
import type { StatusMarkState } from "@/components/ui/status-mark";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { startupDecision } from "@/features/thread-startup/startup-step-copy";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { threadAttentionStore } from "./thread-attention-store";
import { deriveThreadRowState, type NeedsYouLabel, type ThreadRowSetup, type ThreadRowState } from "./thread-row-state";

/** Every label a thread's status corner can show; "Closed" is the brief state while a close is in flight. */
export type ThreadStatusLabel = NeedsYouLabel | "Running" | "Failed" | "Finished" | "Closed";

/** How a status renders: the mark's state (which sets the colour role), its icon, and the label set beside it. */
export interface ThreadStatusLook {
  label: ThreadStatusLabel;
  state: StatusMarkState;
  icon: LucideIcon | undefined;
}

/** A row state's look, or null for a quiet row, which shows its relative time instead. */
export type ThreadRowLook = ThreadStatusLook | null;

const look = (label: ThreadStatusLabel, state: StatusMarkState, icon?: LucideIcon): ThreadStatusLook => ({ label, state, icon });

/**
 * One entry per label, so rows, roll-ups and the palette cannot disagree on a status's look.
 * "Setup failed" asks the user to decide, but it is a failure, so it reads as one. Running keeps
 * the mark's spinner, so it has no icon.
 */
export const THREAD_STATUS_LOOK: Record<ThreadStatusLabel, ThreadStatusLook> = {
  "Approval required": look("Approval required", "attention", ShieldAlert),
  "Answers required": look("Answers required", "attention", MessageCircleQuestion),
  "Plan ready": look("Plan ready", "attention", ListChecks),
  Interrupted: look("Interrupted", "attention", CirclePause),
  "Setup failed": look("Setup failed", "error", CircleAlert),
  Running: look("Running", "running"),
  Failed: look("Failed", "error", CircleAlert),
  Finished: look("Finished", "success", CircleCheck),
  Closed: look("Closed", "success", CircleCheck),
};

/** Maps a row state to its status look; a quiet row has none. */
export function threadRowLook(state: ThreadRowState): ThreadRowLook {
  switch (state.kind) {
    case "needs-you":
      return THREAD_STATUS_LOOK[state.label];
    case "running":
      return THREAD_STATUS_LOOK.Running;
    case "failed":
      return THREAD_STATUS_LOOK.Failed;
    case "finished":
      return THREAD_STATUS_LOOK.Finished;
    case "quiet":
      return null;
  }
}

/** How strongly a row title reads: `prominent` is full ink, `receded` is muted. */
export type ThreadTitleTone = "prominent" | "receded";

/**
 * A quiet thread (no status) recedes, so every row with a status, running included, stands out;
 * the selected row keeps full ink so the thread the user is reading stays legible.
 */
export function threadTitleTone(state: ThreadRowState, selected: boolean): ThreadTitleTone {
  return state.kind === "quiet" && !selected ? "receded" : "prominent";
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
export function useThreadRowState(threadId: string, preparing = false, createFailed = false): ThreadRowState {
  const attention = threadAttentionStore((state) => state.byThreadId[threadId]);
  const onScreen = threadAttentionStore((state) => state.onScreenThreadId === threadId);
  const executing = useThreadStore((state) => isThreadExecuting(threadId, state));
  const startupPending = useWorkspaceStore((state) => state.pendingStartupByThreadId[threadId] !== undefined);
  const setup = useThreadStartupStore((state) => threadRowSetup(threadStartupRecord(state, threadId)));
  return deriveThreadRowState({ attention, running: executing || startupPending || preparing, setup, onScreen, createFailed });
}

/** Reads a thread's row state outside React from the same facts as {@link useThreadRowState}. */
export function readThreadRowState(threadId: string, preparing = false, createFailed = false): ThreadRowState {
  const { byThreadId, onScreenThreadId } = threadAttentionStore.getState();
  const startupPending = useWorkspaceStore.getState().pendingStartupByThreadId[threadId] !== undefined;
  return deriveThreadRowState({
    attention: byThreadId[threadId],
    running: isThreadExecuting(threadId, useThreadStore.getState()) || startupPending || preparing,
    setup: threadRowSetup(threadStartupRecord(useThreadStartupStore.getState(), threadId)),
    onScreen: onScreenThreadId === threadId,
    createFailed,
  });
}
