import { create } from "zustand";
import type { PlanRecord } from "@mcode/contracts";

/** Zustand state shape for per-thread plan data. */
interface PlanState {
  /** All plan versions keyed by thread ID, ordered by version ASC. */
  plansByThread: Record<string, readonly PlanRecord[]>;

  /** Which version is currently viewed per thread (null = latest). */
  activeVersionByThread: Record<string, number | null>;

  /** Threads currently generating a new plan version. */
  generatingThreads: Set<string>;

  /** Add or replace a plan in the thread's version list. */
  addPlan: (threadId: string, plan: PlanRecord) => void;

  /** Set the actively viewed version for a thread. */
  setActiveVersion: (threadId: string, version: number | null) => void;

  /** Mark a thread as generating a plan (shows skeleton). */
  setGenerating: (threadId: string, generating: boolean) => void;

  /** Update a plan's status optimistically. */
  updatePlanStatus: (planId: string, status: PlanRecord["status"]) => void;

  /** Clear plan state for a thread. */
  clearPlans: (threadId: string) => void;
}

/** Zustand store for per-thread plan versions. */
export const usePlanStore = create<PlanState>((set) => ({
  plansByThread: {},
  activeVersionByThread: {},
  generatingThreads: new Set(),

  addPlan: (threadId, plan) =>
    set((state) => {
      const existing = state.plansByThread[threadId] ?? [];
      const idx = existing.findIndex((p) => p.version === plan.version);
      const updated =
        idx >= 0
          ? existing.map((p, i) => (i === idx ? plan : p))
          : [...existing, plan].sort((a, b) => a.version - b.version);
      return {
        plansByThread: { ...state.plansByThread, [threadId]: updated },
        // Clear generating flag when a plan arrives
        generatingThreads: new Set(
          [...state.generatingThreads].filter((id) => id !== threadId),
        ),
      };
    }),

  setActiveVersion: (threadId, version) =>
    set((state) => ({
      activeVersionByThread: {
        ...state.activeVersionByThread,
        [threadId]: version,
      },
    })),

  setGenerating: (threadId, generating) =>
    set((state) => {
      const next = new Set(state.generatingThreads);
      if (generating) next.add(threadId);
      else next.delete(threadId);
      return { generatingThreads: next };
    }),

  updatePlanStatus: (planId, status) =>
    set((state) => {
      const updated: Record<string, readonly PlanRecord[]> = {};
      for (const [tid, plans] of Object.entries(state.plansByThread)) {
        updated[tid] = plans.map((p) =>
          p.id === planId ? { ...p, status } : p,
        );
      }
      return { plansByThread: updated };
    }),

  clearPlans: (threadId) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitPlans, ...rest } = state.plansByThread;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitVersion, ...restVersions } = state.activeVersionByThread;
      return { plansByThread: rest, activeVersionByThread: restVersions };
    }),
}));
