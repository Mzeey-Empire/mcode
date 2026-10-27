import type { WorkspaceThread } from "@/lib/workspace-thread";
import type { SidebarThreadFacts } from "../sidebar/sidebar-model";

const indexCache = new WeakMap<readonly WorkspaceThread[], ReadonlyMap<string, WorkspaceThread>>();

/** Id to thread, built once per `threads` array identity and shared by every caller. */
export function selectThreadIndex(threads: readonly WorkspaceThread[]): ReadonlyMap<string, WorkspaceThread> {
  const cached = indexCache.get(threads);
  if (cached) return cached;
  const index = new Map(threads.map((thread) => [thread.id, thread]));
  indexCache.set(threads, index);
  return index;
}

const NO_PREPARING: ReadonlySet<string> = new Set();
let preparingCache: { threads: readonly WorkspaceThread[]; ids: ReadonlySet<string> } | null = null;

/** Ids of threads still preparing their first send; the same set while membership is unchanged. */
export function selectPreparingThreadIds(threads: readonly WorkspaceThread[]): ReadonlySet<string> {
  if (preparingCache?.threads === threads) return preparingCache.ids;
  const ids = new Set<string>();
  for (const thread of threads) if (thread.clientPreparing === true) ids.add(thread.id);
  const previous = preparingCache?.ids ?? NO_PREPARING;
  const same = ids.size === previous.size && [...ids].every((id) => previous.has(id));
  preparingCache = { threads, ids: same ? previous : ids };
  return preparingCache.ids;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toFacts(thread: WorkspaceThread): SidebarThreadFacts {
  return {
    id: thread.id,
    workspaceId: thread.workspace_id,
    parentId: thread.parent_thread_id ?? null,
    activityMs: parseTime(thread.last_activity_at) ?? parseTime(thread.created_at) ?? 0,
    completedMs: parseTime(thread.user_completed_at),
  };
}

function sameFacts(a: SidebarThreadFacts, b: SidebarThreadFacts): boolean {
  return a.id === b.id && a.workspaceId === b.workspaceId && a.parentId === b.parentId
    && a.activityMs === b.activityMs && a.completedMs === b.completedMs;
}

interface FactsCache {
  readonly threads: readonly WorkspaceThread[];
  readonly facts: readonly SidebarThreadFacts[];
  readonly byId: ReadonlyMap<string, SidebarThreadFacts>;
}

let factsCache: FactsCache | null = null;

/**
 * Returns sidebar facts, reusing unchanged fact objects and the array when all facts stay equal.
 */
export function selectSidebarFacts(threads: readonly WorkspaceThread[]): readonly SidebarThreadFacts[] {
  if (factsCache?.threads === threads) return factsCache.facts;
  const previous = factsCache;
  let changed = previous === null || previous.facts.length !== threads.length;
  const facts = threads.map((thread, index) => {
    // Most pushes replace one thread; every other object is the one already parsed at this index.
    if (previous && previous.threads[index] === thread) return previous.facts[index]!;
    const fresh = toFacts(thread);
    const old = previous?.byId.get(thread.id);
    const kept = old && sameFacts(old, fresh) ? old : fresh;
    if (kept !== previous?.facts[index]) changed = true;
    return kept;
  });
  if (previous && !changed) {
    factsCache = { ...previous, threads };
    return previous.facts;
  }
  factsCache = { threads, facts, byId: new Map(facts.map((fact) => [fact.id, fact])) };
  return facts;
}
