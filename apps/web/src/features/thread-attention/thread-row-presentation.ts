import { CircleAlert, CircleCheck, CirclePause, Layers, ListChecks, MessageCircleQuestion, ShieldAlert, type LucideIcon } from "lucide-react";
import type { StatusMarkState } from "@/components/ui/status-mark";
import { startupPhaseRunningLabel } from "@/features/thread-startup/startup-step-copy";
import { threadAttentionStore } from "./thread-attention-store";
import { readThreadActivity, useThreadActivity } from "./thread-activity";
import { deriveThreadRowState, type NeedsYouLabel, type ThreadRowState } from "./thread-row-state";

/** Every label a thread's status corner can show; "Closed" is the brief state while a close is in flight. */
export type ThreadStatusLabel = NeedsYouLabel | "Setting up" | "Running" | "Waiting" | "Failed" | "Finished" | "Closed";

/** How a status renders: the mark's state (which sets the colour role), its icon, and the label set beside it. */
export interface ThreadStatusLook {
  label: ThreadStatusLabel;
  state: StatusMarkState;
  icon: LucideIcon | undefined;
  /** What the status is doing now, for the tooltip; the label stays short. */
  detail?: string;
}

/** A row state's look, or null for a quiet row, which shows its relative time instead. */
export type ThreadRowLook = ThreadStatusLook | null;

const look = (label: ThreadStatusLabel, state: StatusMarkState, icon?: LucideIcon): ThreadStatusLook => ({ label, state, icon });

/**
 * One entry per label, so rows, roll-ups and the palette cannot disagree on a status's look.
 * "Setup failed" and "Fetch failed" ask the user to decide, but they are failures, so they read as
 * one. Setting up, Running and Waiting keep the mark's spinner, so they have no icon; Waiting's
 * subagents are still working, so it is busy the same way.
 */
export const THREAD_STATUS_LOOK: Record<ThreadStatusLabel, ThreadStatusLook> = {
  "Approval required": look("Approval required", "attention", ShieldAlert),
  "Answers required": look("Answers required", "attention", MessageCircleQuestion),
  "Plan ready": look("Plan ready", "attention", ListChecks),
  Interrupted: look("Interrupted", "attention", CirclePause),
  "Setup failed": look("Setup failed", "error", CircleAlert),
  "Fetch failed": look("Fetch failed", "error", CircleAlert),
  "Subagent needs you": look("Subagent needs you", "attention", Layers),
  "Setting up": look("Setting up", "running"),
  Running: look("Running", "running"),
  Waiting: look("Waiting", "running"),
  Failed: look("Failed", "error", CircleAlert),
  Finished: look("Finished", "success", CircleCheck),
  Closed: look("Closed", "success", CircleCheck),
};

/** Maps a row state to its status look; a quiet row has none. */
export function threadRowLook(state: ThreadRowState): ThreadRowLook {
  switch (state.kind) {
    case "needs-you":
      return THREAD_STATUS_LOOK[state.label];
    case "setting-up":
      return { ...THREAD_STATUS_LOOK["Setting up"], detail: startupPhaseRunningLabel(state.phase) };
    case "running":
      return THREAD_STATUS_LOOK.Running;
    case "waiting":
      return THREAD_STATUS_LOOK.Waiting;
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

/**
 * Subscribes a row to the facts that pick its state. Every surface reads the thread's
 * activity from the shared stores, so a palette result, an expanded row and a collapsed
 * project roll-up never disagree about one thread.
 */
export function useThreadRowState(threadId: string, preparing = false, createFailed = false): ThreadRowState {
  const attention = threadAttentionStore((state) => state.byThreadId[threadId]);
  const onScreen = threadAttentionStore((state) => state.onScreenThreadId === threadId);
  const activity = useThreadActivity(threadId, { preparing, createFailed });
  return deriveThreadRowState({ activity, attention, onScreen });
}

/** Reads a thread's row state outside React from the same facts as {@link useThreadRowState}. */
export function readThreadRowState(threadId: string, preparing = false, createFailed = false): ThreadRowState {
  const { byThreadId, onScreenThreadId } = threadAttentionStore.getState();
  return deriveThreadRowState({
    activity: readThreadActivity(threadId, { preparing, createFailed }),
    attention: byThreadId[threadId],
    onScreen: onScreenThreadId === threadId,
  });
}
