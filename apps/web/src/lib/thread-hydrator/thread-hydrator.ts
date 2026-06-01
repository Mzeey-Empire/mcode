import {
  cacheRecord,
  evictCachedRecord,
  getCachedRecord,
  hasCachedRecord,
} from "./record-cache";
import {
  createEmptyThreadRecord,
  getThreadRecord,
  patchThreadRecord,
} from "@/stores/thread-record";
import type { ThreadRecord } from "@/stores/thread-record";
import type {
  HydrateMode,
  NarrativeBatchResult,
  ThreadHydratorDeps,
  ThreadHydratorOptions,
  ThreadHydratorTransport,
  ThreadHydratorWriteState,
} from "./types";
import type { NarrativeEntry } from "@mcode/contracts";
import { snapshotBuilder } from "./snapshot-builder";
import { AuxiliaryHydrator } from "./auxiliary-hydrator";

/** Initial message fetch size per thread. */
export const MESSAGE_FETCH_SIZE = 100;

/** Auxiliary side-effect refresh TTL (permissions, tasks, plans). */
export const HYDRATION_TTL_MS = 2000;

/** Assistant messages to eager-prefetch narrative for on cache miss. */
const NARRATIVE_PREFETCH_BATCH = 20;

/** Background hover prefetch limit (matches legacy prefetch.ts). */
export const BACKGROUND_PREFETCH_LIMIT = 100;

/**
 * Owns the full "load this thread" flow: cache lookup, RPC fetch, record
 * commit, auxiliary fanout, and narrative prefetch.
 */
export class ThreadHydrator {
  private readonly auxiliaryHydrator: AuxiliaryHydrator;

  constructor(private readonly deps: ThreadHydratorDeps) {
    this.auxiliaryHydrator = new AuxiliaryHydrator({
      getTransport: deps.getTransport,
      getState: deps.getState,
      setState: deps.setState,
      getWorkspaceThread: deps.getWorkspaceThread,
      getTasksForThread: deps.getTasksForThread,
      setTasksForThread: deps.setTasksForThread,
      addPlanForThread: deps.addPlanForThread,
      shallowEqualBy: deps.shallowEqualBy,
      coerceTaskStatus: deps.coerceTaskStatus,
    });
  }

  private transport(): ThreadHydratorTransport {
    return this.deps.getTransport();
  }

  /**
   * Load a thread's in-memory record.
   * Active mode commits to the live store; background mode writes the cache only.
   */
  async hydrate(
    threadId: string,
    mode: HydrateMode,
    opts?: ThreadHydratorOptions,
  ): Promise<void> {
    if (mode === "background") {
      await this.hydrateBackground(threadId);
      return;
    }
    await this.hydrateActive(threadId, opts);
  }

  /** Speculative cache warm on sidebar hover — no live-store mutation. */
  private async hydrateBackground(threadId: string): Promise<void> {
    if (hasCachedRecord(threadId)) return;

    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const [messageResult, snapshots] = await Promise.all([
        this.transport().getMessages(threadId, BACKGROUND_PREFETCH_LIMIT),
        shouldFetchSnapshots
          ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
          : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>),
      ]);

      if (hasCachedRecord(threadId)) return;

      const patch = snapshotBuilder.build({
        messages: messageResult.messages,
        hasMore: messageResult.hasMore,
        answeredPlanMessageIds: messageResult.answeredPlanMessageIds,
        snapshots,
      });

      const record: ThreadRecord = {
        ...createEmptyThreadRecord(),
        ...patch,
        settings: this.deps.getWorkspaceThreadSettings(threadId),
      };
      cacheRecord(threadId, record);
    } catch {
      // Background prefetch is speculative; swallow errors silently.
    }
  }

  /** Active-thread load invoked from ChatView and workspaceStore. */
  private async hydrateActive(threadId: string, opts?: ThreadHydratorOptions): Promise<void> {
    // Defer until after the cache-restore set() so outgoing-thread streaming
    // previews do not trigger a mid-switch MessageList re-render.
    queueMicrotask(this.deps.flushPendingTextDeltas);

    const cached = getCachedRecord(threadId);
    if (cached) {
      this.restoreFromCache(threadId, cached);
      this.auxiliaryHydrator.hydrate(threadId, {
        freshnessTtlMs: HYDRATION_TTL_MS,
        force: opts?.force,
        commitFileChangesToStore: true,
      });
      return;
    }

    await this.fetchAndCommit(threadId, opts);
  }

  /**
   * Synchronously restore from a cached {@link ThreadRecord}.
   *
   * Auxiliary-owned fields (`permissions`, `lastHydratedAt`) are preserved from
   * the live record because the cache snapshot is taken synchronously after
   * `auxiliaryHydrator.hydrate()` fires its async RPCs, so the cached values
   * are typically stale relative to whatever the auxiliary writes settle to.
   * The auxiliary fanout that runs after restoration will refresh them anyway.
   */
  private restoreFromCache(threadId: string, cached: ThreadRecord): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      // The cache snapshot predates in-flight narration, so for a running
      // thread the live record wins (mirrors fetchAndCommit's isRunning guard).
      const isRunning = state.runningThreadIds.has(threadId);
      const liveVolatile: Partial<ThreadRecord> = isRunning
        ? {
            toolCalls: current.toolCalls,
            thoughtSegments: current.thoughtSegments,
            hooks: current.hooks,
            streaming: current.streaming,
            streamingPreview: current.streamingPreview,
            agentStartTime: current.agentStartTime,
            currentTurnMessageId: current.currentTurnMessageId,
            isCompacting: current.isCompacting,
          }
        : {};
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...cached,
          error: null,
          loading: false,
          loadEpoch: current.loadEpoch + 1,
          isLoadingMore: false,
          lastHydratedAt: current.lastHydratedAt,
          permissions: current.permissions,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
          ...liveVolatile,
        }),
        currentThreadId: threadId,
      };
    });
  }

  /** Cache-miss path: reset volatile state, fetch RPCs, commit, populate cache. */
  private async fetchAndCommit(threadId: string, opts?: ThreadHydratorOptions): Promise<void> {
    const { getState, setState } = this.deps;
    const isRunning = getState().runningThreadIds.has(threadId);

    if (!isRunning) {
      getState().toolCallRecordCache.clear();
      setState((state: ThreadHydratorWriteState) => {
        const current = getThreadRecord(state.records, threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            loading: true,
            error: null,
            messages: [],
            persistedToolCallCounts: {},
            persistedFilesChanged: {},
            latestTurnWithChanges: null,
            isLoadingMore: false,
            loadEpoch: current.loadEpoch + 1,
            streaming: "",
            streamingPreview: "",
            toolCalls: [],
            currentTurnMessageId: "",
            thoughtSegments: [],
            hooks: [],
            isCompacting: false,
            agentStartTime: undefined,
            settings: this.deps.getWorkspaceThreadSettings(threadId),
          }),
          currentThreadId: threadId,
        };
      });
    } else {
      setState((state: ThreadHydratorWriteState) => {
        const current = getThreadRecord(state.records, threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            loading: true,
            error: null,
            messages: [],
            persistedToolCallCounts: {},
            persistedFilesChanged: {},
            latestTurnWithChanges: null,
            isLoadingMore: false,
            loadEpoch: current.loadEpoch + 1,
            settings: this.deps.getWorkspaceThreadSettings(threadId),
          }),
          currentThreadId: threadId,
        };
      });
    }

    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const [messageResult, snapshots] = await Promise.all([
        this.transport().getMessages(threadId, MESSAGE_FETCH_SIZE),
        shouldFetchSnapshots
          ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
          : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>),
      ]);

      if (getState().currentThreadId !== threadId) return;

      const patch = snapshotBuilder.build({
        messages: messageResult.messages,
        hasMore: messageResult.hasMore,
        answeredPlanMessageIds: messageResult.answeredPlanMessageIds,
        snapshots,
      });

      setState((state: ThreadHydratorWriteState) => ({
        records: patchThreadRecord(state.records, threadId, {
          ...patch,
          loading: false,
          isLoadingMore: false,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
      }));

      this.prefetchNarratives(threadId, patch.messages);

      this.auxiliaryHydrator.hydrate(threadId, {
        freshnessTtlMs: HYDRATION_TTL_MS,
        force: opts?.force ?? true,
        commitFileChangesToStore: true,
      });

      const committed = getThreadRecord(getState().records, threadId);
      if (committed.planQuestionsStatus !== "pending") {
        const pendingQuestions = this.deps.extractPendingPlanQuestions(
          committed.messages,
          committed.answeredPlanMessageIds,
        );
        if (pendingQuestions) {
          this.deps.setPlanQuestions(threadId, pendingQuestions);
        }
      }

      cacheRecord(threadId, getThreadRecord(getState().records, threadId));
    } catch (e) {
      if (getState().currentThreadId === threadId) {
        setState((state: ThreadHydratorWriteState) => ({
          records: patchThreadRecord(state.records, threadId, {
            error: String(e),
            loading: false,
          }),
        }));
      }
      evictCachedRecord(threadId);
    }
  }

  /**
   * Eager-hydrate persisted narrative for the thread via the single
   * server-ordered `turn.load` call, then group the flat {@link NarrativeEntry}
   * list back into the per-message {@link NarrativeBatchResult} shape that
   * `narrativeByMessage` consumers expect (back-compat is intentional).
   *
   * On `turn.load` rejection we leave the lazy per-message
   * `loadNarrativeForMessage` (`narrative.list`) path to fill in, so hydration
   * never crashes on a transport failure.
   */
  private prefetchNarratives(threadId: string, messages: import("@/transport").Message[]): void {
    const lastAssistants = messages.filter((m) => m.role === "assistant").slice(-NARRATIVE_PREFETCH_BATCH);
    const narrativeByMessage = getThreadRecord(this.deps.getState().records, threadId).narrativeByMessage;
    const idsToFetch = lastAssistants
      .map((m) => m.id)
      .filter((id) => !narrativeByMessage[id]);

    if (idsToFetch.length === 0) return;

    void this.transport()
      .loadTurn(threadId)
      .then((entries) => {
        const grouped = groupNarrativeEntriesByMessage(entries);
        this.deps.setState((state: ThreadHydratorWriteState) => {
          if (!state.records.has(threadId)) return {};
          const rec = getThreadRecord(state.records, threadId);
          // Preserve already-loaded entries: only commit messages we still need.
          const next = { ...rec.narrativeByMessage };
          for (const id of idsToFetch) {
            next[id] = grouped[id] ?? { tools: [], thoughts: [], hooks: [] };
          }
          return {
            records: patchThreadRecord(state.records, threadId, {
              narrativeByMessage: next,
            }),
          };
        });
      })
      .catch((err) => {
        console.warn("[narrative] turn.load failed, falling back to lazy narrative.list", err);
        for (const m of lastAssistants) {
          void this.deps.loadNarrativeForMessage(m.id);
        }
      });
  }
}

/**
 * Group a flat, server-ordered {@link NarrativeEntry} list into the legacy
 * per-message {@link NarrativeBatchResult} shape keyed by `message_id`.
 *
 * `assistantMessage` entries are skipped: their body already lives on the
 * message row, so they do not belong in `narrativeByMessage`. The server
 * already orders entries by (sequence, sortOrder), so per-message arrays
 * preserve that order without re-sorting here.
 */
export function groupNarrativeEntriesByMessage(
  entries: NarrativeEntry[],
): NarrativeBatchResult {
  const grouped: NarrativeBatchResult = {};
  const bucket = (messageId: string): NarrativeBatchResult[string] => {
    let entry = grouped[messageId];
    if (!entry) {
      entry = { tools: [], thoughts: [], hooks: [] };
      grouped[messageId] = entry;
    }
    return entry;
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "toolCall":
        bucket(entry.record.message_id).tools.push(entry.record);
        break;
      case "narrationSegment":
        bucket(entry.record.message_id).thoughts.push(entry.record);
        break;
      case "hook":
        bucket(entry.record.message_id).hooks.push(entry.record);
        break;
      case "assistantMessage":
        break;
    }
  }

  return grouped;
}

/** Module-scoped hydrator instance registered by threadStore at init. */
let registeredHydrator: ThreadHydrator | null = null;

/** Register the live hydrator instance for prefetch and other callers. */
export function registerThreadHydrator(hydrator: ThreadHydrator): void {
  registeredHydrator = hydrator;
}

/** Return the registered hydrator; throws if threadStore has not initialized yet. */
export function getThreadHydrator(): ThreadHydrator {
  if (!registeredHydrator) {
    throw new Error("ThreadHydrator not initialized");
  }
  return registeredHydrator;
}

/** Factory for the production hydrator wired from threadStore. */
export function createThreadHydrator(deps: ThreadHydratorDeps): ThreadHydrator {
  return new ThreadHydrator(deps);
}

/** Test-only reset of the module-scoped hydrator pointer. */
export function __resetThreadHydratorForTests(): void {
  registeredHydrator = null;
}
