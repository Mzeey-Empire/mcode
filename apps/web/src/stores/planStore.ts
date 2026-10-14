import { create } from "zustand";
import { getCatalogEntry, type PlanComment, type PlanVersion, type PlanVersionStatus } from "@mcode/contracts";

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
 * exists, else the newest version not superseded, else the latest. Null when
 * the thread has no versions.
 */
export function selectViewedPlanVersion(
  versions: readonly PlanVersion[],
  activeVersion: number | null,
): PlanVersion | null {
  const picked = activeVersion === null ? undefined : versions.find((v) => v.version === activeVersion);
  return picked ?? newestUnsuperseded(versions) ?? versions.at(-1) ?? null;
}

function newestUnsuperseded(versions: readonly PlanVersion[]): PlanVersion | undefined {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    if (versions[i].status !== "superseded") return versions[i];
  }
  return undefined;
}

/**
 * Whether the Plan editor accepts typing: only on the thread's latest version,
 * only while it is a draft or ready, and never while a turn runs.
 */
export function isPlanVersionEditable(viewed: PlanVersion, latest: PlanVersion, threadExecuting: boolean): boolean {
  if (threadExecuting || viewed.id !== latest.id) return false;
  return viewed.status === "draft" || viewed.status === "ready";
}

/**
 * The word that follows "v{N}" in the Plan panel: who or what the version is.
 * A ready version names the provider that wrote it.
 */
export function planVersionWord(plan: Pick<PlanVersion, "status" | "providerId">): string {
  switch (plan.status) {
    case "draft":
      return "Edited by you";
    case "accepted":
      return "Accepted";
    case "superseded":
      return "Older version";
    case "ready":
      return plan.providerId === null ? "Agent" : getCatalogEntry(plan.providerId).name;
  }
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

  /** Plan comments keyed by thread ID, across all of the thread's versions. */
  commentsByThread: Record<string, readonly PlanComment[]>;

  /** Replace a thread's comments with the server's snapshot. */
  setComments: (threadId: string, comments: readonly PlanComment[]) => void;

  /** Apply a `plan.commentsChanged` push, or the result of a comment write. */
  applyCommentsChanged: (threadId: string, upserted: readonly PlanComment[], deletedIds: readonly string[]) => void;

  /** Clear plan state for a thread. */
  clearPlans: (threadId: string) => void;
}

// A write's result and its push can arrive in either order, so an upsert never
// replaces a comment the store already has at a later update.
function upsertComments(
  current: readonly PlanComment[],
  upserted: readonly PlanComment[],
  deletedIds: readonly string[],
): readonly PlanComment[] {
  const deleted = new Set(deletedIds);
  const byId = new Map(current.filter((comment) => !deleted.has(comment.id)).map((comment) => [comment.id, comment]));
  for (const comment of upserted) {
    const existing = byId.get(comment.id);
    if (!existing || existing.updatedAt <= comment.updatedAt) byId.set(comment.id, comment);
  }
  return [...byId.values()];
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

  commentsByThread: {},

  setComments: (threadId, comments) =>
    set((state) => ({ commentsByThread: { ...state.commentsByThread, [threadId]: comments } })),

  applyCommentsChanged: (threadId, upserted, deletedIds) =>
    set((state) => ({
      commentsByThread: {
        ...state.commentsByThread,
        [threadId]: upsertComments(state.commentsByThread[threadId] ?? [], upserted, deletedIds),
      },
    })),

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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _omitComments, ...restComments } = state.commentsByThread;
      return { plansByThread: rest, activeVersionByThread: restVersions, commentsByThread: restComments };
    }),
}));
