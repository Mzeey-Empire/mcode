import { create } from "zustand";
import type { Thread } from "@mcode/contracts/models/thread";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "../state/workspaceStore";
import { HOLD_MS, transitionCompletion, type CompletionEntry, type CompletionEvent } from "./completion-machine";

interface CompletionStoreState {
  readonly entries: ReadonlyMap<string, CompletionEntry>;
  readonly hoveredThreadId: string | null;
}

interface CompletionStoreActions {
  complete(threadId: string): void;
  undo(threadId: string): void;
  retry(threadId: string): void;
  pointerEntered(threadId: string): void;
  pointerLeft(threadId: string): void;
  observeServerLifecycle(threadId: string, completed: boolean): void;
}

type CompletionStore = CompletionStoreState & CompletionStoreActions;

let nextAttempt = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Holds optimistic completions across row unmounts. Undo cancels the server hold; confirmed
 * completions apply the server lifecycle and release resources.
 */
export const useCompletionStore = create<CompletionStore>((set, get) => {
  const confirmedThreads = new Map<string, Thread>();

  const dispatch = (threadId: string, event: CompletionEvent): void => {
    const { next, effects } = transitionCompletion(get().entries.get(threadId), event);
    if (next !== get().entries.get(threadId)) {
      const entries = new Map(get().entries);
      if (next) entries.set(threadId, next);
      else entries.delete(threadId);
      set({ entries });
    }
    for (const effect of effects) {
      if (effect.type === "send-complete") sendComplete(threadId, effect.attempt);
      else if (effect.type === "send-reopen") void useWorkspaceStore.getState().reopenThread(threadId).catch(() => undefined);
      else applyConfirmed(threadId);
    }
  };

  const applyConfirmed = (threadId: string): void => {
    const thread = confirmedThreads.get(threadId);
    confirmedThreads.delete(threadId);
    if (thread) useWorkspaceStore.getState().applyThreadLifecycle(thread);
  };

  const sendComplete = (threadId: string, attempt: number): void => {
    getTransport().completeThread(threadId, HOLD_MS).then(
      (result) => {
        if (!result.ok) {
          dispatch(threadId, { type: "refused", attempt, refusal: result.refusal });
          return;
        }
        confirmedThreads.set(threadId, result.thread);
        dispatch(threadId, { type: "confirmed", attempt, pointerOnRow: get().hoveredThreadId === threadId });
        confirmedThreads.delete(threadId);
      },
      (error: unknown) => dispatch(threadId, { type: "connection-failed", attempt, message: errorMessage(error) }),
    );
  };

  return {
    entries: new Map(),
    hoveredThreadId: null,
    complete: (threadId) => dispatch(threadId, { type: "complete", attempt: ++nextAttempt }),
    undo: (threadId) => dispatch(threadId, { type: "undo" }),
    retry: (threadId) => dispatch(threadId, { type: "retry", attempt: ++nextAttempt }),
    pointerEntered: (threadId) => set({ hoveredThreadId: threadId }),
    pointerLeft: (threadId) => {
      if (get().hoveredThreadId === threadId) set({ hoveredThreadId: null });
      dispatch(threadId, { type: "pointer-left" });
    },
    observeServerLifecycle: (threadId, completed) => dispatch(threadId, { type: "server-lifecycle", completed }),
  };
});
