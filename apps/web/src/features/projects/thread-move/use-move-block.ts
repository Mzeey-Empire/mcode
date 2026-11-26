import { commandsOf, useBackgroundCommandStore } from "@/features/background-commands/backgroundCommandStore";
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
  // Waiting covers subagents and awaited commands. An unawaited command shows only in the command list, which is
  // loaded for the open thread; for any other thread the server's refusal explains it in the dialog.
  const commandRunning = useBackgroundCommandStore((state) => commandsOf(state.loads.get(thread.id))?.some((command) => command.status === "running") ?? false);
  return moveBlockOf(activity.turnRunning, awaitingApproval, rowState.kind === "waiting" || commandRunning);
}
