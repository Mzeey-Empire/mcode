import { create } from "zustand";
import type { PlanVersion, PlanVersionStatus } from "@mcode/contracts";

const statusOrder: Record<PlanVersionStatus, number> = { draft: 0, ready: 0, superseded: 1, accepted: 2 };

// Snapshots and pushes can arrive out of order, so content follows the higher
// revision and status only moves forward.
function mergeVersion(current: PlanVersion, incoming: PlanVersion): PlanVersion {
  const content = current.revision > incoming.revision ? current : incoming;
  const status = statusOrder[current.status] > statusOrder[incoming.status] ? current : incoming;
  return { ...content, status: status.status, acceptedAt: status.acceptedAt, acceptedMessageId: status.acceptedMessageId };
}

/**
 * The version a thread's Plan panel shows: the picked version while it still
 * exists, else the latest. Null when the thread has no versions.
 */
export function selectViewedPlanVersion(
  versions: readonly PlanVersion[],
  activeVersion: number | null,
): PlanVersion | null {
  const picked = activeVersion === null ? undefined : versions.find((v) => v.version === activeVersion);
  return picked ?? versions.at(-1) ?? null;
}

/** Zustand state shape for per-thread plan data. */
interface PlanState {
  /** All plan versions keyed by thread ID, ordered by version ASC. */
  plansByThread: Record<string, readonly PlanVersion[]>;

  /** Which version is currently viewed per thread (null = latest). */
  activeVersionByThread: Record<string, number | null>;

  /** Add a version, or merge it into the stored version with the same number. */
  addPlan: (threadId: string, plan: PlanVersion) => void;

  /** Set the actively viewed version for a thread (null = latest). */
  setActiveVersion: (threadId: string, version: number | null) => void;

  /** Clear plan state for a thread. */
  clearPlans: (threadId: string) => void;
}

/** Zustand store for per-thread plan versions. */
export const usePlanStore = create<PlanState>((set) => ({
  plansByThread: {},
  activeVersionByThread: {},

  addPlan: (threadId, plan) =>
    set((state) => {
      const existing = state.plansByThread[threadId] ?? [];
      const idx = existing.findIndex((p) => p.version === plan.version);
      const updated =
        idx >= 0
          ? existing.map((p, i) => (i === idx ? mergeVersion(p, plan) : p))
          : [...existing, plan].sort((a, b) => a.version - b.version);
      return { plansByThread: { ...state.plansByThread, [threadId]: updated } };
    }),

  setActiveVersion: (threadId, version) =>
    set((state) => ({
      activeVersionByThread: {
        ...state.activeVersionByThread,
        [threadId]: version,
      },
    })),

  clearPlans: (threadId) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitPlans, ...rest } = state.plansByThread;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitVersion, ...restVersions } = state.activeVersionByThread;
      return { plansByThread: rest, activeVersionByThread: restVersions };
    }),
}));
