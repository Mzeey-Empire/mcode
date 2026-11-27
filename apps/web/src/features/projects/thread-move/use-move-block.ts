import { useCallback, useMemo, useSyncExternalStore } from "react";
import { commandsOf, useBackgroundCommandLoad, useBackgroundCommandStore, type BackgroundCommandLoad } from "@/features/background-commands/backgroundCommandStore";
import { readThreadActivity, useThreadActivity } from "@/features/thread-attention/thread-activity";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { readThreadRowState, useThreadRowState } from "@/features/thread-attention/thread-row-presentation";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { useThreadStore } from "@/stores/threadStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useWorkspaceStore } from "../state/workspaceStore";
import { MOVE_BLOCK_REASON, type MoveBlock } from "./move-thread-store";

type BlockableThread = Pick<WorkspaceThread, "id" | "clientPreparing" | "clientError">;

function moveBlockOf(running: boolean, awaitingApproval: boolean, backgroundRunning: boolean): MoveBlock | null {
  if (awaitingApproval) return "needs-approval";
  if (running) return "running";
  return backgroundRunning ? "background" : null;
}

function isMoveBlock(value: string): value is MoveBlock {
  return Object.keys(MOVE_BLOCK_REASON).includes(value);
}

function isAwaitingApproval(rowState: ReturnType<typeof readThreadRowState>): boolean {
  return rowState.kind === "needs-you" && rowState.label === "Approval required";
}

function commandsBlockMove(load: BackgroundCommandLoad | undefined, refreshing: boolean): boolean {
  return refreshing || load?.kind === "loading" || (commandsOf(load)?.some((command) => command.status === "running") ?? false);
}

/**
 * Why a thread cannot move right now, or null when it can. The thread menu, the command palette and the
 * sidebar drag all read it, so they refuse in the same cases and with the same words.
 */
export function useMoveBlock(thread: BlockableThread): MoveBlock | null {
  const preparing = thread.clientPreparing === true;
  const createFailed = thread.clientError != null;
  const activity = useThreadActivity(thread.id, { preparing, createFailed });
  const rowState = useThreadRowState(thread.id, preparing, createFailed);
  // Waiting covers subagents and awaited commands. An unawaited command shows only in the command list. Reading the
  // list here loads it and keeps it fresh by push, so a thread is never movable on the strength of a list that
  // has not arrived: until it does, the thread counts as busy. A failed load cannot say either way, so it does not
  // block; the server's refusal then explains it in the dialog.
  const load = useBackgroundCommandLoad(thread.id);
  const refreshing = useBackgroundCommandStore((state) => state.refreshing.has(thread.id));
  return moveBlockOf(activity.turnRunning, isAwaitingApproval(rowState), rowState.kind === "waiting" || commandsBlockMove(load, refreshing));
}

// If this client has not requested the list, the server can still explain a busy refusal.
function readMoveBlock(thread: BlockableThread): MoveBlock | null {
  const preparing = thread.clientPreparing === true;
  const createFailed = thread.clientError != null;
  const activity = readThreadActivity(thread.id, { preparing, createFailed });
  const rowState = readThreadRowState(thread.id, preparing, createFailed);
  const { loads, refreshing } = useBackgroundCommandStore.getState();
  return moveBlockOf(activity.turnRunning, isAwaitingApproval(rowState), rowState.kind === "waiting" || commandsBlockMove(loads.get(thread.id), refreshing.has(thread.id)));
}

const BLOCK_STORES = [useThreadStore, threadAttentionStore, useThreadStartupStore, useWorkspaceStore, useBackgroundCommandStore] as const;

function subscribeToBlockStores(onChange: () => void): () => void {
  const unsubscribes = BLOCK_STORES.map((store) => store.subscribe(onChange));
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

/**
 * The block of each of several threads, for a move that takes all of them along. A hook per thread would break
 * when the set changes, so this reads every verdict into one string, which React can compare, and parses it back.
 */
export function useMoveBlocks(threads: readonly BlockableThread[]): ReadonlyMap<string, MoveBlock> {
  const read = useCallback(
    () => threads.map((thread) => `${thread.id}\u0000${readMoveBlock(thread) ?? ""}`).join("\u0001"),
    [threads],
  );
  const snapshot = useSyncExternalStore(subscribeToBlockStores, read, read);
  return useMemo(() => {
    const blocks = new Map<string, MoveBlock>();
    for (const entry of snapshot.split("\u0001")) {
      const [id, block] = entry.split("\u0000");
      if (id && block && isMoveBlock(block)) blocks.set(id, block);
    }
    return blocks;
  }, [snapshot]);
}
