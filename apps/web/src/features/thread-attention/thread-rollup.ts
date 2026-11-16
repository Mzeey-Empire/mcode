import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { getExecutingThreadIds, useThreadStore } from "@/stores/threadStore";
import { threadAttentionStore } from "./thread-attention-store";
import { threadRowSetup, threadStartupRecord } from "./thread-row-presentation";
import { deriveThreadRowState, rollUpThreadRowStates, type ThreadRowState } from "./thread-row-state";

/** The fields of a sidebar thread the roll-up reads beyond the shared stores. */
export type RollUpThread = Pick<WorkspaceThread, "id" | "clientPreparing" | "clientError">;

/** Highest-priority row state across threads; an empty list is quiet. */
export function useRolledUpThreadRowState(threads: readonly RollUpThread[]): ThreadRowState {
  const executing = useThreadStore(useShallow(getExecutingThreadIds));
  const pendingStartup = useWorkspaceStore((state) => state.pendingStartupByThreadId);
  const attention = threadAttentionStore((state) => state.byThreadId);
  const onScreenThreadId = threadAttentionStore((state) => state.onScreenThreadId);
  const startups = useThreadStartupStore(useShallow((state) => ({
    recordsByStartupId: state.recordsByStartupId,
    startupIdByThreadId: state.startupIdByThreadId,
  })));
  const running = new Set(executing);
  return rollUpThreadRowStates(threads.map((thread) => deriveThreadRowState({
    attention: attention[thread.id],
    running: running.has(thread.id) || pendingStartup[thread.id] !== undefined || thread.clientPreparing === true,
    setup: threadRowSetup(threadStartupRecord(startups, thread.id)),
    onScreen: onScreenThreadId === thread.id,
    createFailed: thread.clientError != null,
  })));
}

/** Roll-up over every open thread (user_completed_at === null) in the workspace store, whatever sidebar scope shows. */
export function useOpenThreadsRowState(): ThreadRowState {
  const openThreads = useWorkspaceStore(useShallow((state) => state.threads.filter((thread) => thread.user_completed_at === null)));
  return useRolledUpThreadRowState(openThreads);
}
