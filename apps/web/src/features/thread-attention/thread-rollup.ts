import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { getExecutingThreadIds, useThreadStore } from "@/stores/threadStore";
import { threadAttentionStore } from "./thread-attention-store";
import { deriveThreadActivity, threadStartupRecord } from "./thread-activity";
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
    activity: deriveThreadActivity({
      record: threadStartupRecord(startups, thread.id),
      local: {
        preparing: thread.clientPreparing === true,
        pendingStartup: pendingStartup[thread.id] !== undefined,
        createFailed: thread.clientError != null,
      },
      turnRunning: running.has(thread.id),
    }),
    attention: attention[thread.id],
    onScreen: onScreenThreadId === thread.id,
  })));
}

/** Roll-up over every open thread (user_completed_at === null) in the workspace store, whatever sidebar scope shows. */
export function useOpenThreadsRowState(): ThreadRowState {
  const openThreads = useWorkspaceStore(useShallow((state) => state.threads.filter((thread) => thread.user_completed_at === null)));
  return useRolledUpThreadRowState(openThreads);
}
