import { commandsOf, useBackgroundCommandLoad, useBackgroundCommandStore } from "@/features/background-commands/backgroundCommandStore";
import { useThreadActivity } from "@/features/thread-attention/thread-activity";
import { useThreadRowState } from "@/features/thread-attention/thread-row-presentation";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import type { MoveBlock } from "./move-thread-store";

function moveBlockOf(running: boolean, awaitingApproval: boolean, backgroundRunning: boolean): MoveBlock | null {
  if (awaitingApproval) return "needs-approval";
  if (running) return "running";
  return backgroundRunning ? "background" : null;
}

/**
 * Why a thread cannot move right now, or null when it can. The thread menu, the command palette and the
 * sidebar drag all read it, so they refuse in the same cases and with the same words.
 */
export function useMoveBlock(thread: Pick<WorkspaceThread, "id" | "clientPreparing" | "clientError">): MoveBlock | null {
  const preparing = thread.clientPreparing === true;
  const createFailed = thread.clientError != null;
  const activity = useThreadActivity(thread.id, { preparing, createFailed });
  const rowState = useThreadRowState(thread.id, preparing, createFailed);
  const awaitingApproval = rowState.kind === "needs-you" && rowState.label === "Approval required";
  // Waiting covers subagents and awaited commands. An unawaited command shows only in the command list. Reading the
  // list here loads it and keeps it fresh by push, so a thread is never movable on the strength of a list that
  // has not arrived: until it does, the thread counts as busy. A failed load cannot say either way, so it does not
  // block; the server's refusal then explains it in the dialog.
  const load = useBackgroundCommandLoad(thread.id);
  const commandRunning = commandsOf(load)?.some((command) => command.status === "running") ?? false;
  const refreshing = useBackgroundCommandStore((state) => state.refreshing.has(thread.id));
  const commandsUnknown = load.kind === "loading" || refreshing;
  return moveBlockOf(activity.turnRunning, awaitingApproval, rowState.kind === "waiting" || commandRunning || commandsUnknown);
}
