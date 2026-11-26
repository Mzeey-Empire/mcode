import { useEffect } from "react";
import { registerCommand } from "@/lib/command-registry";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useWorkspaceStore } from "../state/workspaceStore";
import { MOVE_BLOCK_REASON, offersMoveToProject, openMoveThreadDialog } from "./move-thread-store";
import { useMoveBlock } from "./use-move-block";

/**
 * Puts Move thread to project in the command palette while the selected thread is an open No project thread.
 * It renders nothing; the entry is the registration.
 */
export function MoveThreadCommand() {
  const thread = useWorkspaceStore((state) => state.threads.find((candidate) => candidate.id === state.activeThreadId));
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === thread?.workspace_id));
  return thread && offersMoveToProject(thread, workspace) ? <RegisteredMoveCommand thread={thread} /> : null;
}

function RegisteredMoveCommand({ thread }: { thread: WorkspaceThread }) {
  const block = useMoveBlock(thread);
  const disabledReason = block ? MOVE_BLOCK_REASON[block] : undefined;
  useEffect(() => registerCommand({
    id: "thread.moveToProject",
    title: "Move thread to project…",
    category: "Thread",
    disabledReason,
    handler: () => openMoveThreadDialog(thread.id),
  }), [thread.id, disabledReason]);
  return null;
}
