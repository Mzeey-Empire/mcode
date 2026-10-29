import { create } from "zustand";

/** A manual cleanup retry in flight, or its failure. */
export interface CleanupRetryUi {
  readonly pending: boolean;
  readonly error: string | null;
}

interface RowLifecycleState {
  /** Threads whose Complete or Reopen request is in flight. */
  readonly pendingLifecycle: ReadonlySet<string>;
  readonly cleanupRetry: ReadonlyMap<string, CleanupRetryUi>;
  setLifecyclePending(threadId: string, pending: boolean): void;
  setCleanupRetry(threadId: string, value: CleanupRetryUi | null): void;
  reset(): void;
}

/** Idle cleanup retry, shared so selectors return a stable value. */
export const IDLE_CLEANUP_RETRY: CleanupRetryUi = { pending: false, error: null };

/** In-flight lifecycle actions and cleanup retry state that persists while sidebar rows unmount. */
export const useRowLifecycleStore = create<RowLifecycleState>((set) => ({
  pendingLifecycle: new Set(),
  cleanupRetry: new Map(),
  setLifecyclePending: (threadId, pending) => set((state) => {
    if (state.pendingLifecycle.has(threadId) === pending) return state;
    const next = new Set(state.pendingLifecycle);
    if (pending) next.add(threadId);
    else next.delete(threadId);
    return { pendingLifecycle: next };
  }),
  setCleanupRetry: (threadId, value) => set((state) => {
    const next = new Map(state.cleanupRetry);
    if (value) next.set(threadId, value);
    else next.delete(threadId);
    return { cleanupRetry: next };
  }),
  reset: () => set({ pendingLifecycle: new Set(), cleanupRetry: new Map() }),
}));
