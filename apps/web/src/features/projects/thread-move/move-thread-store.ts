import { create } from "zustand";
import type { Workspace } from "@mcode/contracts/models/workspace";
import type { WorkspaceThread } from "@/lib/workspace-thread";

/** Which thread the move dialog is open for, or null while it is closed. */
export const useMoveThreadStore = create<{ readonly threadId: string | null }>(() => ({ threadId: null }));

/** Opens the move dialog for a No project thread. */
export function openMoveThreadDialog(threadId: string): void {
  useMoveThreadStore.setState({ threadId });
}

/** Closes the move dialog. */
export function closeMoveThreadDialog(): void {
  useMoveThreadStore.setState({ threadId: null });
}

/** Why the thread menu blocks a move. */
export type MoveBlock = "running" | "needs-approval" | "background";

/** The menu's second line for a thread that cannot move yet. */
export const MOVE_BLOCK_REASON: Readonly<Record<MoveBlock, string>> = {
  running: "This thread is running",
  "needs-approval": "This thread needs approval",
  background: "Work is still running in the background",
};

/**
 * Whether the thread menu offers Move to project at all: only an open thread that lives in the hidden No project
 * workspace. A closed thread has left the active list, and a placeholder is not on the server yet.
 */
export function offersMoveToProject(thread: Pick<WorkspaceThread, "user_completed_at" | "status" | "clientPreparing">, workspace: Pick<Workspace, "kind"> | undefined): boolean {
  return workspace?.kind === "no_project"
    && thread.user_completed_at === null
    && thread.clientPreparing !== true
    && thread.status !== "archived"
    && thread.status !== "deleted";
}
