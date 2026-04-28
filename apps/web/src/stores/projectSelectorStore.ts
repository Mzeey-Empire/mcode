import { create } from "zustand";

/** Enrichment data for a workspace: branch, clean state, thread count. */
export interface WorkspaceEnrichmentData {
  id: string;
  branch: string | null;
  isGit: boolean;
  isClean: boolean;
  threadCount: number;
}

interface State {
  /** Keyed by workspace id. Populated lazily via enrich(). */
  enrichmentCache: Map<string, WorkspaceEnrichmentData>;
  /** Workspace ids whose enrichment RPC is currently in flight. */
  pending: Set<string>;
  /**
   * Fetch enrichment for the given workspace ids.
   * Already-cached and in-flight ids are skipped to avoid redundant RPCs.
   * @param ids - Workspace ids to enrich.
   * @param call - Optional transport override (defaults to wsCall). Injected in tests.
   */
  enrich: (ids: string[], call?: (method: string, params: any) => Promise<any>) => Promise<void>;
}

/**
 * Perform batched enrichment of workspace ids.
 *
 * Defined outside the store initializer so the function reference is stable
 * and survives full-state replacements in tests (setState with replace=true).
 * Already-cached and in-flight ids are skipped to prevent duplicate RPCs.
 */
async function enrichImpl(
  ids: string[],
  call?: (method: string, params: any) => Promise<any>,
): Promise<void> {
  if (ids.length === 0) return;
  const store = useProjectSelectorStore;
  const { enrichmentCache, pending } = store.getState();
  const todo = ids.filter((id) => !enrichmentCache.has(id) && !pending.has(id));
  if (todo.length === 0) return;

  // Mark as in-flight before the async boundary so concurrent calls see them immediately.
  const nextPending = new Set(store.getState().pending);
  todo.forEach((id) => nextPending.add(id));
  store.setState({ pending: nextPending });

  try {
    const transport = call ?? (await import("../transport/ws-transport").then((m) => m.wsCall));
    const { items } = await transport("workspace.enrich", { ids: todo });
    const next = new Map(store.getState().enrichmentCache);
    for (const item of items) next.set(String(item.id), item);
    store.setState({ enrichmentCache: next });
  } finally {
    const cleaned = new Set(store.getState().pending);
    todo.forEach((id) => cleaned.delete(id));
    store.setState({ pending: cleaned });
  }
}

/**
 * Single source of truth for workspace enrichment data (branch, clean state, thread count).
 * Both the palette ProjectsView and the cold-start ProjectSelectorLanding subscribe here.
 * Enrichment is fetched lazily and cached so repeated renders don't trigger duplicate RPCs.
 */
export const useProjectSelectorStore = create<State>(() => ({
  enrichmentCache: new Map(),
  pending: new Set(),
  enrich: enrichImpl,
}));

// Patch the store's setState so full-state replacements (replace=true) always
// restore the stable `enrich` action. This lets tests reset data-only state
// without losing the action reference.
const originalSetState = useProjectSelectorStore.setState.bind(useProjectSelectorStore);
useProjectSelectorStore.setState = (
  partial: State | Partial<State> | ((state: State) => State | Partial<State>),
  replace?: boolean,
) => {
  originalSetState(partial as any, replace as any);
  // If replace wiped the enrich function, restore it.
  if (!useProjectSelectorStore.getState().enrich) {
    originalSetState({ enrich: enrichImpl } as Partial<State>, false);
  }
};
