import { create } from "zustand";
import type { Message, ToolCall, HookExecution, PermissionMode, InteractionMode, AttachmentMeta, ToolCallRecord } from "@/transport";
import type { ThoughtSegment } from "@/components/chat/narrative/types";
import type { ContextWindowMode, ReasoningLevel, PlanQuestion, PlanAnswer, ProviderUsageInfo, QuotaCategory, TurnSnapshot } from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { PlanQuestionSchema, PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "./workspaceStore";
import { useQueueStore } from "./queueStore";
import { LruCache } from "@/lib/lru-cache";
import { useTaskStore, coerceTaskStatus } from "./taskStore";
import type { TaskItem } from "./taskStore";
import { useToastStore } from "./toastStore";
import { findModelById } from "@/lib/model-registry";
import { resolveContextWindow } from "@/lib/resolve-context-window";
import { useSettingsStore } from "./settingsStore";
import {
  cacheSnapshot,
  evictThread as evictMessageCache,
  getCachedSnapshot,
} from "./messageCache";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { forgetScrollTop } from "@/components/chat/scrollPositionMemory";
import { releaseBrowserCaptureSpills } from "@/lib/browser-capture-spill";

/** A permission request with its current resolution state. */
interface StoredPermission extends PermissionRequest {
  settled: boolean;
  decision?: PermissionDecision;
}

/** Per-thread configuration for permission scope, interaction mode, and optional reasoning level. */
export interface ThreadSettings {
  /** Permission scope applied when the agent calls tools on this thread. */
  permissionMode: PermissionMode;
  /** Interaction style (e.g. auto-edit vs review) for this thread. */
  interactionMode: InteractionMode;
  /** Reasoning level selected for this thread, forwarded on the post-wizard answer turn. */
  reasoningLevel?: ReasoningLevel;
  /** Selected Copilot sub-agent name. Null means provider default. Only relevant when provider is "copilot". */
  copilotAgent?: string | null;
  /**
   * Per-thread context window override. Null clears the override so the thread
   * inherits from the global settings default. Honored only by Claude provider
   * for models that support a 1M-context beta header.
   */
  contextWindow?: ContextWindowMode | null;
  /**
   * Per-thread thinking toggle override. Null clears the override so the thread
   * inherits from the global settings default. Honored only by models that
   * expose a thinking toggle (Haiku 4.5).
   */
  thinking?: boolean | null;
}

interface ThreadState {
  messages: Message[];
  runningThreadIds: Set<string>;
  loading: boolean;
  /** Per-thread error messages keyed by threadId. Prevents background thread errors from leaking into the active thread's UI. */
  errorByThread: Record<string, string | null>;
  currentThreadId: string | null;
  /** Full accumulated streaming text per thread, used for finalization into a message. */
  streamingByThread: Record<string, string>;
  /** Tail-truncated preview of the streaming text (last 200 chars), used by StreamingCard for render optimization. */
  streamingPreviewByThread: Record<string, string>;
  toolCallsByThread: Record<string, ToolCall[]>;
  agentStartTimes: Record<string, number>;
  /** Per-thread permission mode and interaction mode. */
  settingsByThread: Record<string, ThreadSettings>;
  /** Tool call counts per message ID, populated from turn.persisted events and loadMessages. */
  persistedToolCallCounts: Record<string, number>;
  /** Files changed per message ID, populated from turn.persisted events. Empty array = no changes. */
  persistedFilesChanged: Record<string, string[]>;
  /** Message ID of the most recent completed turn with file changes. Only this turn's summary is expanded; older ones auto-collapse. */
  latestTurnWithChanges: string | null;
  /** Maps client-generated message IDs to server-persisted message IDs for API calls. */
  serverMessageIds: Record<string, string>;
  /** Cache for tool call records to avoid re-fetching from server. */
  toolCallRecordCache: LruCache<string, ToolCallRecord[]>;
  /** Tracks the local message ID for the most recent assistant message per thread, used by handleTurnPersisted to correctly assign tool call counts. */
  currentTurnMessageIdByThread: Record<string, string>;
  /** Lowest sequence number currently loaded per thread, used as cursor for "load older". */
  oldestLoadedSequence: Record<string, number>;
  /** Whether older messages exist beyond what is loaded, per thread. */
  hasMoreMessages: Record<string, boolean>;
  /** Guard against duplicate scroll-triggered fetches per thread. */
  isLoadingMore: Record<string, boolean>;
  /** Monotonic counter incremented on each loadMessages call, used to discard stale loadOlderMessages responses. */
  loadEpochByThread: Record<string, number>;
  /** Last known token usage and context window size per thread, updated on turn completion. */
  contextByThread: Record<string, { lastTokensIn: number; contextWindow?: number; totalProcessedTokens?: number; tokensOut?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMultiplier?: number }>;
  /** Provider-level quota and usage info, keyed by `${threadId}:${providerId}`. Updated on session.quotaUpdate events and explicit fetches. */
  usageByProvider: Record<string, ProviderUsageInfo>;
  /** Whether the SDK is currently compacting the context window for a thread. */
  isCompactingByThread: Record<string, boolean>;
  /** Transient fallback state per thread. Cleared when the user sends the next message. */
  lastFallbackByThread: Record<string, { requestedModel: string; actualModel: string }>;
  /** Transient rate-limit indicator per thread. Cleared when the provider reports the limit has lifted. */
  rateLimitByThread: Record<string, { retryAfterMs?: number; limitType?: string; utilization?: number }>;
  /** Transient API retry indicator per thread. Cleared when a non-retry event arrives. */
  apiRetryByThread: Record<string, { reason: string; attempt?: number; maxRetries?: number; delayMs?: number }>;
  /** Questions proposed by the model in plan mode, keyed by thread ID. Null when not pending. */
  planQuestionsByThread: Record<string, PlanQuestion[] | null>;
  /** User's answers to plan questions, keyed by thread ID then question ID. */
  planAnswersByThread: Record<string, Map<string, PlanAnswer>>;
  /** Currently focused question index per thread (0-based). */
  activeQuestionIndexByThread: Record<string, number>;
  /** Plan wizard status per thread. */
  planQuestionsStatusByThread: Record<string, "idle" | "pending" | "answered">;
  /**
   * Server-authoritative set of assistant message IDs whose plan-questions
   * block has been answered, per thread. Hydrated from `message.list` and
   * extended by the `plan.answered` push channel.
   */
  answeredPlanMessageIdsByThread: Record<string, Set<string>>;
  /** Pending and recently-settled permission requests per thread. */
  permissionsByThread: Record<string, StoredPermission[]>;
  /** Ephemeral hook execution state per thread. Cleared on page reload, not persisted to DB. */
  hooksByThread: Record<string, HookExecution[]>;
  /** Ephemeral thought segments for the current turn per thread. Cleared on turnComplete/ended. */
  thoughtSegmentsByThread: Record<string, ThoughtSegment[]>;
  /**
   * After `agent.stop`, each thread ID is marked until `turn.persisted` arrives for that
   * thread, so we can show a one-shot file-change notice without colliding across threads.
   */
  awaitingUserStopPersistByThread: Record<string, true>;
  /** Dismissible notice per thread: stop interrupted a turn that produced workspace file changes. */
  interruptStopFileNoticeByThread: Record<string, { paths: string[] }>;
  /** Pre-fill the composer with the last user prompt after Stop, keyed by thread (consumed by Composer). */
  composerRecallFromStopByThread: Record<string, { text: string }>;

  /** Store tool call records in the cache. */
  cacheToolCallRecords: (key: string, records: ToolCallRecord[]) => void;
  /** Retrieve cached tool call records, or null if not cached. */
  getCachedToolCallRecords: (key: string) => ToolCallRecord[] | null;
  /** Evict the entire tool call record cache. Records are re-fetched on next expand. */
  clearToolCallRecordCache: () => void;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  loadOlderMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], displayContent?: string, reasoningLevel?: ReasoningLevel, provider?: string, copilotAgent?: string, contextWindow?: ContextWindowMode, thinking?: boolean, replyToMessageId?: string, quotedText?: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  /** Replace runningThreadIds with the authoritative server snapshot. Called on WS (re)connect. */
  hydrateRunningThreads: (ids: string[]) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  /** Returns true if an agent is actively executing on the given thread. */
  isThreadRunning: (threadId: string) => boolean;
  /** Set questions received from the model and show the wizard. */
  setPlanQuestions: (threadId: string, questions: PlanQuestion[]) => void;
  /** Record the user's answer for one question. */
  setPlanAnswer: (threadId: string, questionId: string, answer: PlanAnswer) => void;
  /** Navigate to a specific question index. */
  setActiveQuestionIndex: (threadId: string, index: number) => void;
  /** Submit all answers to the server and dismiss the wizard. */
  submitPlanAnswers: (threadId: string) => Promise<void>;
  /** Reset plan question state for a thread (called on clear/reload). */
  clearPlanQuestions: (threadId: string) => void;
  /**
   * Record that the plan-questions block on `assistantMessageId` has been
   * answered server-side, and dismiss the wizard for that thread. Wired to
   * the `plan.answered` push channel from `ws-events.ts`.
   */
  markPlanAnswered: (threadId: string, assistantMessageId: string) => void;
  /** Add a new pending permission request for a thread. */
  addPermissionRequest: (request: PermissionRequest) => void;
  /** Mark a permission request as settled with its decision. */
  resolvePermissionRequest: (requestId: string, decision: PermissionDecision) => void;
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;

  /** Handle server-side tool call persistence confirmation. */
  handleTurnPersisted: (payload: { threadId: string; messageId: string; toolCallCount: number; filesChanged: string[] }) => void;
  /** Clear the interrupt file-notice banner for one thread (user dismissed). */
  clearInterruptStopFileNotice: (threadId: string) => void;
  /** Clears composer recall state for one thread after the Composer applies it. */
  clearComposerRecallFromStop: (threadId: string) => void;

  // Per-thread settings
  /** Return current settings for a thread, preferring in-memory overrides over DB-persisted values. */
  getThreadSettings: (threadId: string) => ThreadSettings;
  /** Merge partial settings and persist to server. Resolves to false if RPC fails or patch is empty. */
  setThreadSettings: (threadId: string, settings: Partial<ThreadSettings>) => Promise<boolean>;

  /** Fetch and refresh provider usage info from the server for the given thread and provider. */
  fetchProviderUsage: (threadId: string, providerId: string) => Promise<void>;
  /** Remove all per-thread state for a deleted thread. Clears visible-thread globals when the deleted thread is the current one. */
  clearThreadState: (threadId: string) => void;
  /** Batch variant of clearThreadState. Prunes all IDs in a single Zustand set() call to avoid N sequential re-renders. Used by deleteWorkspace. */
  clearThreadStateMany: (threadIds: string[]) => void;
}

/** Pending dequeue timers per thread, so duplicate turnComplete events don't double-dequeue. */
const dequeueTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDequeueTimer(threadId: string) {
  const timer = dequeueTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    dequeueTimers.delete(threadId);
  }
}

/**
 * Resume auto-drain for a thread that was paused while the user edited a
 * queued message. Schedules the same 400ms-delayed check used by the
 * turnComplete handler. No-op when the thread is busy or the queue is empty.
 */
export function scheduleDrainAfterEdit(threadId: string): void {
  clearDequeueTimer(threadId);
  const timer = setTimeout(() => {
    dequeueTimers.delete(threadId);
    const threadExists = useWorkspaceStore.getState().threads.some(
      (t) => t.id === threadId && t.deleted_at == null,
    );
    if (!threadExists) return;
    if (useThreadStore.getState().runningThreadIds.has(threadId)) return;
    if (useQueueStore.getState().editingThreadId === threadId) return;

    const next = useQueueStore.getState().dequeueNext(threadId);
    if (next) {
      void (async (): Promise<void> => {
        try {
          await useThreadStore.getState().sendMessage(
            threadId,
            next.content,
            next.model,
            next.permissionMode,
            next.attachments.length > 0 ? next.attachments : undefined,
            next.displayContent,
            next.reasoningLevel,
            next.provider,
            next.copilotAgent,
            next.contextWindow,
            next.thinking,
            next.replyToMessageId,
            next.quotedText,
          );
        } catch {
          void releaseBrowserCaptureSpills(next.browserCaptureSpillPaths ?? []);
        }
      })();
    }
  }, 400);
  dequeueTimers.set(threadId, timer);
}

/**
 * Shallow-clone `rec` and omit `key`. Returns a new object.
 * Used by clearThreadState and clearMessages to prune per-thread maps without mutating state.
 */
function omitKey<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const next = { ...rec };
  delete next[key];
  return next;
}

/**
 * Returns how many Agent (subagent) tool calls are still in flight for status UI.
 */
export function countActiveSubagentCalls(calls: ToolCall[] | undefined): number {
  if (!calls?.length) return 0;
  let n = 0;
  for (const tc of calls) {
    if (tc.toolName === "Agent" && !tc.isComplete) n++;
  }
  return n;
}

const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  permissionMode: PERMISSION_MODES.FULL,
  interactionMode: INTERACTION_MODES.CHAT,
};

/** Maximum entries in the tool call record LRU cache. */
export const TOOL_CALL_CACHE_SIZE = 200;

/** Number of older messages to fetch per pagination request. */
export const OLDER_PAGE_SIZE = 50;

/** Maximum messages kept in the in-memory sliding window. */
export const MESSAGE_WINDOW_SIZE = 200;

/** Initial message fetch size per thread */
export const MESSAGE_FETCH_SIZE = 100;

/**
 * Enforce the sliding window cap on a messages array.
 * Returns the trimmed array and whether messages were evicted.
 */
function capMessages(messages: Message[]): { messages: Message[]; evicted: boolean } {
  if (messages.length <= MESSAGE_WINDOW_SIZE) {
    return { messages, evicted: false };
  }
  return {
    messages: messages.slice(messages.length - MESSAGE_WINDOW_SIZE),
    evicted: true,
  };
}

/**
 * Scan a message list for an unanswered plan-questions block.
 * Finds the last assistant message containing a ```plan-questions``` fenced block,
 * confirms no user message follows it (meaning questions haven't been answered yet),
 * then parses and validates the JSON array inside the block.
 * Returns the parsed questions or null if none found.
 */
/**
 * Walk messages newest-first to find the latest assistant `plan-questions`
 * fence and decide whether the wizard should pop.
 *
 * Decision order:
 *   1. The fence assistant message id is in `answeredIds` -> null (answered).
 *   2. A user message follows the fence in the array -> null (legacy fallback
 *      for threads that answered plan-questions before the marker landed).
 *   3. Otherwise -> parsed questions.
 *
 * Trailing assistant messages without a fence (e.g. a partially-streamed
 * follow-up) are skipped so the wizard still surfaces while the model is
 * mid-turn.
 */
export function extractPendingPlanQuestions(
  messages: Message[],
  answeredIds: ReadonlySet<string>,
): PlanQuestion[] | null {
  const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

  // First pass: locate the fence message index, walking newest-first.
  let fenceIndex = -1;
  let fenceContent: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const match = msg.content.match(PLAN_QUESTIONS_RE);
    if (match) {
      fenceIndex = i;
      fenceContent = match[1];
      break;
    }
  }
  if (fenceIndex === -1 || fenceContent == null) return null;

  // Authoritative marker: the server says this round was answered.
  if (answeredIds.has(messages[fenceIndex].id)) return null;

  // Legacy fallback: any user message after the fence implies the user
  // already answered (covers threads from before the marker existed).
  for (let i = fenceIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "user") return null;
  }

  try {
    const raw = JSON.parse(fenceContent);
    if (!Array.isArray(raw)) return null;
    const results = raw.map((item) => PlanQuestionSchema.safeParse(item));
    // Reject the whole batch if any question fails — partial batches break
    // index continuity between the wizard UI and the answer map keys.
    if (results.some((r) => !r.success)) return null;
    const validated = results.map(
      (r) => (r as { success: true; data: PlanQuestion }).data,
    );
    return validated.length > 0 ? validated : null;
  } catch {
    return null;
  }
}

/** Zustand store for thread-scoped messages, streaming session state, and agent event handling. */
export const useThreadStore = create<ThreadState>((set, get) => {
  let textDeltaFlushRaf: number | null = null;
  const pendingTextDeltaByThread = new Map<string, string>();

  /** Applies coalesced `session.textDelta` strings batched on `requestAnimationFrame`. */
  const flushPendingTextDeltas = () => {
    if (textDeltaFlushRaf != null) {
      cancelAnimationFrame(textDeltaFlushRaf);
      textDeltaFlushRaf = null;
    }
    if (pendingTextDeltaByThread.size === 0) return;
    const batch = new Map(pendingTextDeltaByThread);
    pendingTextDeltaByThread.clear();
    set((state) => {
      const nextStreaming = { ...state.streamingByThread };
      const nextPreview = { ...state.streamingPreviewByThread };
      const nextSegments = { ...state.thoughtSegmentsByThread };
      for (const [tid, acc] of batch) {
        if (!acc) continue;
        const cur = nextStreaming[tid] ?? "";
        const combined = cur + acc;
        nextStreaming[tid] = combined;
        nextPreview[tid] = combined.length > 200 ? combined.slice(-200) : combined;

        // Manage thought segments: append to the active segment or start a new one.
        const segments = nextSegments[tid] ?? [];
        const last = segments[segments.length - 1];
        if (!last || last.endedAt !== undefined) {
          nextSegments[tid] = [...segments, { text: acc, startedAt: Date.now() }];
        } else {
          nextSegments[tid] = [
            ...segments.slice(0, -1),
            { ...last, text: last.text + acc },
          ];
        }
      }
      return {
        streamingByThread: nextStreaming,
        streamingPreviewByThread: nextPreview,
        thoughtSegmentsByThread: nextSegments,
      };
    });
  };

  const scheduleTextDeltaFlush = () => {
    if (textDeltaFlushRaf != null) return;
    textDeltaFlushRaf = requestAnimationFrame(() => {
      textDeltaFlushRaf = null;
      flushPendingTextDeltas();
    });
  };

  return {
    messages: [],
  runningThreadIds: new Set<string>(),
  loading: false,
  errorByThread: {},
  currentThreadId: null,
  streamingByThread: {},
  streamingPreviewByThread: {},
  toolCallsByThread: {},
  agentStartTimes: {},
  settingsByThread: {},
  persistedToolCallCounts: {},
  persistedFilesChanged: {},
  latestTurnWithChanges: null,
  serverMessageIds: {},
  toolCallRecordCache: new LruCache<string, ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
  currentTurnMessageIdByThread: {},
  oldestLoadedSequence: {},
  hasMoreMessages: {},
  isLoadingMore: {},
  loadEpochByThread: {},
  contextByThread: {},
  usageByProvider: {},
  isCompactingByThread: {},
  lastFallbackByThread: {},
  rateLimitByThread: {},
  apiRetryByThread: {},
  planQuestionsByThread: {},
  planAnswersByThread: {},
  activeQuestionIndexByThread: {},
  planQuestionsStatusByThread: {},
  answeredPlanMessageIdsByThread: {},
  permissionsByThread: {},
  hooksByThread: {},
  thoughtSegmentsByThread: {},
  awaitingUserStopPersistByThread: {},
  interruptStopFileNoticeByThread: {},
  composerRecallFromStopByThread: {},

  cacheToolCallRecords: (key, records) => {
    get().toolCallRecordCache.set(key, records);
  },

  getCachedToolCallRecords: (key) => {
    return get().toolCallRecordCache.get(key) ?? null;
  },

  /** Evict the entire tool call record cache. Records are re-fetched on next expand. */
  clearToolCallRecordCache: () => {
    get().toolCallRecordCache.clear();
  },

  /**
   * Fetch persisted messages for a thread from the database.
   * For non-running threads, clears stale real-time state (tool calls,
   * streaming text, agent start times) so artifacts
   * from a previous visit don't linger. Running threads keep their
   * real-time state intact to avoid disrupting live tool call rendering.
   */
  loadMessages: async (threadId) => {
    flushPendingTextDeltas();
    // Cache-hit fast path. Restores message-loading state synchronously,
    // skipping the getMessages RPC and avoiding the blank-flash transition.
    const cached = getCachedSnapshot(threadId);
    if (cached) {
      set((state) => {
        const nextErrors = { ...state.errorByThread };
        delete nextErrors[threadId];
        return {
          loading: false,
          errorByThread: nextErrors,
          currentThreadId: threadId,
          messages: cached.messages,
          persistedToolCallCounts: cached.persistedToolCallCounts,
          persistedFilesChanged: cached.persistedFilesChanged,
          latestTurnWithChanges: cached.latestTurnWithChanges,
          oldestLoadedSequence: { ...state.oldestLoadedSequence, [threadId]: cached.oldestLoadedSequence },
          hasMoreMessages: { ...state.hasMoreMessages, [threadId]: cached.hasMoreMessages },
          isLoadingMore: {},
          // Bump epoch so any pending loadOlderMessages from the previous activation is discarded.
          loadEpochByThread: { ...state.loadEpochByThread, [threadId]: (state.loadEpochByThread[threadId] ?? 0) + 1 },
          // Restore plan-question answered markers so the wizard renders correctly on cache hit.
          answeredPlanMessageIdsByThread: {
            ...state.answeredPlanMessageIdsByThread,
            [threadId]: new Set<string>(cached.answeredPlanMessageIds),
          },
          // Note: toolCallRecordCache is intentionally NOT cleared on cache hit
          // so previously expanded tool calls don't refetch.
        };
      });

      // Side-effect refresh: pending permissions and tasks may have changed since cache was last written.
      void getTransport()
        .listPendingPermissions(threadId)
        .then((pending) => {
          const mapped = pending.map((p) => ({ ...p, settled: false }));
          const current = get().permissionsByThread[threadId] ?? [];
          if (!shallowEqualBy(mapped, current, ["requestId", "toolName", "settled"])) {
            set((s) => ({
              permissionsByThread: {
                ...s.permissionsByThread,
                [threadId]: mapped,
              },
            }));
          }
        })
        .catch(() => { /* non-critical */ });

      getTransport()
        .getThreadTasks(threadId)
        .then((tasks) => {
          const items: TaskItem[] = (tasks ?? []).map((t, i) => ({
            id: String(i),
            content: t.content,
            status: coerceTaskStatus(t.status),
            group: "Tasks",
          }));
          const currentTasks = useTaskStore.getState().tasksByThread[threadId] ?? [];
          if (!shallowEqualBy(items, currentTasks, ["content", "status"])) {
            useTaskStore.getState().setTasks(threadId, items);
          }
        })
        .catch((err) => {
          console.debug("[taskHydration] Failed to load tasks for thread %s:", threadId, err);
        });

      // If the cached snapshot has no file-change data but the thread has changes,
      // fetch snapshots in the background (covers prefetched entries).
      const threadRecord = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
      if (threadRecord?.has_file_changes && !cached.latestTurnWithChanges) {
        void getTransport().listSnapshots(threadId).then((snapshots) => {
          if (snapshots.length === 0) return;
          // Re-read current cache entry to avoid overwriting fresher data
          // that loadOlderMessages or another path may have written.
          const latestCached = getCachedSnapshot(threadId);
          if (!latestCached) return;

          const persistedFilesChangedMap: Record<string, string[]> = {};
          let latestTurnWithChanges: string | null = null;
          for (const snap of snapshots) {
            if (snap.files_changed.length === 0) continue;
            persistedFilesChangedMap[snap.message_id] = snap.files_changed;
            // Snapshots sorted ASC by created_at, so last match wins
            latestTurnWithChanges = snap.message_id;
          }
          // Persist back into cache so subsequent visits don't re-fetch
          cacheSnapshot(threadId, {
            ...latestCached,
            persistedFilesChanged: {
              ...latestCached.persistedFilesChanged,
              ...persistedFilesChangedMap,
            },
            latestTurnWithChanges,
          });
          if (get().currentThreadId !== threadId) return;
          set((state) => {
            if (state.currentThreadId !== threadId) return {};
            return {
              persistedFilesChanged: { ...state.persistedFilesChanged, ...persistedFilesChangedMap },
              latestTurnWithChanges,
            };
          });
        }).catch(() => { /* non-critical */ });
      }

      return;
    }

    // ----- Cache miss: existing path, with cache-populate at the end. -----
    const isRunning = get().runningThreadIds.has(threadId);
    if (!isRunning) {
      get().toolCallRecordCache.clear();
      set((state) => {
        const nextToolCalls = { ...state.toolCallsByThread };
        delete nextToolCalls[threadId];
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        const nextTurnMsgIds = { ...state.currentTurnMessageIdByThread };
        delete nextTurnMsgIds[threadId];
        const nextCompacting = { ...state.isCompactingByThread };
        delete nextCompacting[threadId];
        const nextErrors = { ...state.errorByThread };
        delete nextErrors[threadId];
        return {
          loading: true,
          errorByThread: nextErrors,
          currentThreadId: threadId,
          messages: [],
          persistedToolCallCounts: {},
          persistedFilesChanged: {},
          latestTurnWithChanges: null,
          isLoadingMore: {},
          loadEpochByThread: { ...state.loadEpochByThread, [threadId]: (state.loadEpochByThread[threadId] ?? 0) + 1 },
          toolCallsByThread: nextToolCalls,
          streamingByThread: nextStreaming,
          agentStartTimes: nextStartTimes,
          currentTurnMessageIdByThread: nextTurnMsgIds,
          isCompactingByThread: nextCompacting,
        };
      });
    } else {
      set((state) => {
        const nextErrors = { ...state.errorByThread };
        delete nextErrors[threadId];
        return {
        loading: true,
        errorByThread: nextErrors,
        currentThreadId: threadId,
        messages: [],
        persistedToolCallCounts: {},
        persistedFilesChanged: {},
        latestTurnWithChanges: null,
        isLoadingMore: {},
        loadEpochByThread: { ...state.loadEpochByThread, [threadId]: (state.loadEpochByThread[threadId] ?? 0) + 1 },
      };
      });
    }
    try {
      // Determine whether file-change snapshots are needed.
      // When the thread record is absent (race during workspace load), fetch
      // snapshots defensively. Only skip when explicitly has_file_changes=false.
      const threadRecord = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
      const shouldFetchSnapshots = threadRecord?.has_file_changes !== false;

      const [messageResult, snapshots] = await Promise.all([
        getTransport().getMessages(threadId, MESSAGE_FETCH_SIZE),
        shouldFetchSnapshots
          ? getTransport().listSnapshots(threadId).catch(() => [] as TurnSnapshot[])
          : Promise.resolve([] as TurnSnapshot[]),
      ]);

      const { messages, hasMore, answeredPlanMessageIds } = messageResult;

      if (get().currentThreadId === threadId) {
        // Populate persisted tool call counts from loaded messages
        const counts: Record<string, number> = {};
        for (const msg of messages) {
          if (msg.tool_call_count && msg.tool_call_count > 0) {
            counts[msg.id] = msg.tool_call_count;
          }
        }
        const oldest = messages.length > 0 ? messages[0].sequence : 0;

        // Hydrate the per-thread answered-plan-questions marker set from the
        // server response. Older servers omit the field; treat as empty so
        // `extractPendingPlanQuestions` falls back to the legacy heuristic.
        const answeredSet = new Set<string>(answeredPlanMessageIds ?? []);
        set((state) => ({
          messages,
          loading: false,
          persistedToolCallCounts: counts,
          oldestLoadedSequence: { [threadId]: oldest },
          hasMoreMessages: { [threadId]: hasMore },
          isLoadingMore: {},
          answeredPlanMessageIdsByThread: {
            ...state.answeredPlanMessageIdsByThread,
            [threadId]: answeredSet,
          },
        }));

        // Re-hydrate pending permissions (covers reconnect and thread switch)
        void getTransport().listPendingPermissions(threadId).then((pending) => {
          const mapped = pending.map((p) => ({ ...p, settled: false }));
          const current = get().permissionsByThread[threadId] ?? [];
          if (!shallowEqualBy(mapped, current, ["requestId", "toolName", "settled"])) {
            set((s) => ({
              permissionsByThread: {
                ...s.permissionsByThread,
                [threadId]: mapped,
              },
            }));
          }
        }).catch(() => {
          // non-critical; push events will update state if the server pushes
        });

        // Hydrate task panel from persisted TodoWrite state.
        getTransport()
          .getThreadTasks(threadId)
          .then((tasks) => {
            const items: TaskItem[] = (tasks ?? []).map((t, i) => ({
              id: String(i),
              content: t.content,
              status: coerceTaskStatus(t.status),
              group: "Tasks",
            }));
            const currentTasks = useTaskStore.getState().tasksByThread[threadId] ?? [];
            if (!shallowEqualBy(items, currentTasks, ["content", "status"])) {
              useTaskStore.getState().setTasks(threadId, items);
            }
          })
          .catch((err) => {
            console.debug("[taskHydration] Failed to load tasks for thread %s:", threadId, err);
          });

        // Restore the plan question wizard if an unanswered plan-questions block
        // exists in the loaded messages. This handles app restart without losing wizard state.
        const existingStatus = get().planQuestionsStatusByThread[threadId];
        if (existingStatus !== "pending") {
          const pendingQuestions = extractPendingPlanQuestions(messages, answeredSet);
          if (pendingQuestions) {
            get().setPlanQuestions(threadId, pendingQuestions);
          }
        }

        // Process snapshot results into the file-change map.
        // Snapshots arrive sorted by created_at ASC from the DB, so the
        // last match in a forward iteration is the most recent with changes.
        const persistedFilesChangedMap: Record<string, string[]> = {};
        let latestTurnWithChanges: string | null = null;

        if (snapshots.length > 0) {
          for (const snap of snapshots) {
            if (snap.files_changed.length === 0) continue;
            persistedFilesChangedMap[snap.message_id] = snap.files_changed;
            // Snapshots sorted ASC by created_at, so last match wins
            latestTurnWithChanges = snap.message_id;
          }
          set((state) => {
            if (state.currentThreadId !== threadId) return {};
            return {
              persistedFilesChanged: { ...state.persistedFilesChanged, ...persistedFilesChangedMap },
              latestTurnWithChanges,
            };
          });
        }

        cacheSnapshot(threadId, {
          messages,
          oldestLoadedSequence: oldest,
          hasMoreMessages: hasMore,
          persistedToolCallCounts: counts,
          persistedFilesChanged: persistedFilesChangedMap,
          latestTurnWithChanges,
          answeredPlanMessageIds: answeredPlanMessageIds ?? [],
        });
      }
    } catch (e) {
      if (get().currentThreadId === threadId) {
        set((state) => ({
          errorByThread: { ...state.errorByThread, [threadId]: String(e) },
          loading: false,
        }));
      }
      // Defensive: ensure no stale snapshot remains for a thread that just failed to load.
      evictMessageCache(threadId);
    }
  },

  /**
   * Fetch the next batch of older messages for scroll-up pagination.
   * Uses sequence cursor to load messages older than what is currently in memory.
   * Guards against duplicate in-flight requests and stale thread responses.
   */
  loadOlderMessages: async (threadId) => {
    const state = get();
    if (!state.hasMoreMessages[threadId]) return;
    if (state.isLoadingMore[threadId]) return;

    set((s) => ({
      isLoadingMore: { ...s.isLoadingMore, [threadId]: true },
    }));

    try {
      const cursor = get().oldestLoadedSequence[threadId];
      const epoch = get().loadEpochByThread[threadId] ?? 0;
      const { messages: olderMessages, hasMore } = await getTransport().getMessages(threadId, OLDER_PAGE_SIZE, cursor);

      // Discard if thread switched or loadMessages reset state since we started
      const isStale = get().currentThreadId !== threadId
        || (get().loadEpochByThread[threadId] ?? 0) !== epoch;
      if (isStale) {
        set((s) => ({ isLoadingMore: { ...s.isLoadingMore, [threadId]: false } }));
        return;
      }

      // Populate tool call counts from older messages
      const newCounts: Record<string, number> = {};
      for (const msg of olderMessages) {
        if (msg.tool_call_count && msg.tool_call_count > 0) {
          newCounts[msg.id] = msg.tool_call_count;
        }
      }

      const newOldest = olderMessages.length > 0 ? olderMessages[0].sequence : cursor;

      set((s) => ({
        messages: [...olderMessages, ...s.messages],
        persistedToolCallCounts: { ...s.persistedToolCallCounts, ...newCounts },
        oldestLoadedSequence: { ...s.oldestLoadedSequence, [threadId]: newOldest },
        hasMoreMessages: { ...s.hasMoreMessages, [threadId]: hasMore },
        isLoadingMore: { ...s.isLoadingMore, [threadId]: false },
      }));

      // Refresh cache with merged state so snapshot stays current
      const state = get();
      cacheSnapshot(threadId, {
        messages: state.messages,
        oldestLoadedSequence: state.oldestLoadedSequence[threadId],
        hasMoreMessages: state.hasMoreMessages[threadId],
        persistedToolCallCounts: state.persistedToolCallCounts,
        persistedFilesChanged: state.persistedFilesChanged,
        latestTurnWithChanges: state.latestTurnWithChanges,
        answeredPlanMessageIds: [...(state.answeredPlanMessageIdsByThread[threadId] ?? [])],
      });

      // Hydrate file change data for older messages from snapshots
      const olderMsgIds = new Set(olderMessages.map((m) => m.id));
      getTransport()
        .listSnapshots(threadId)
        .then((snapshots) => {
          const relevant = snapshots.filter(
            (s) => s.files_changed.length > 0 && olderMsgIds.has(s.message_id),
          );
          if (relevant.length === 0) return;
          set((state) => {
            if (state.currentThreadId !== threadId) return {};
            const nextFilesChanged = { ...state.persistedFilesChanged };
            for (const snap of relevant) {
              nextFilesChanged[snap.message_id] = snap.files_changed;
            }
            return { persistedFilesChanged: nextFilesChanged };
          });
          // Keep the LRU message cache in sync: the cache was written before this
          // async merge, so a cache-hit thread switch otherwise drops prepended
          // turns' file lists until a full reload.
          const cached = getCachedSnapshot(threadId);
          if (!cached) return;
          const mergedFiles = { ...cached.persistedFilesChanged };
          for (const snap of relevant) {
            mergedFiles[snap.message_id] = snap.files_changed;
          }
          cacheSnapshot(threadId, {
            ...cached,
            persistedFilesChanged: mergedFiles,
          });
        })
        .catch(() => {});
    } catch {
      // Silent failure: reset loading guard so next scroll can retry
      set((s) => ({
        isLoadingMore: { ...s.isLoadingMore, [threadId]: false },
      }));
    }
  },

  /**
   * Send a user message and start the agent. Optimistically appends the
   * message to local state, marks the thread as running, then dispatches
   * to the transport layer. On failure, rolls back the running state.
   */
  sendMessage: async (threadId, content, model, permissionMode, attachments, displayContent, reasoningLevel, provider, copilotAgent, contextWindow, thinking, replyToMessageId, quotedText) => {
    evictMessageCache(threadId);

    // Add user message to local state immediately (optimistic)
    // Use displayContent for the UI (without injected file blocks) if provided
    const userMessage: Message = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: "user",
      content: displayContent ?? content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: get().messages.length + 1,
      attachments: attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })) ?? null,
      reply_to_message_id: replyToMessageId ?? null,
      quoted_text: quotedText ?? null,
    };

    set((state) => ({
      ...(state.currentThreadId === threadId
        ? (() => {
            const { messages: capped, evicted } = capMessages([...state.messages, userMessage]);
            return { messages: capped, ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}) };
          })()
        : {}),
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() },
      // Persist composer-side overrides so the post-wizard answer turn forwards them
      settingsByThread: (reasoningLevel !== undefined || contextWindow !== undefined || thinking !== undefined)
        ? {
            ...state.settingsByThread,
            [threadId]: {
              ...state.getThreadSettings(threadId),
              ...(reasoningLevel !== undefined && { reasoningLevel }),
              ...(contextWindow !== undefined && { contextWindow }),
              ...(thinking !== undefined && { thinking }),
            },
          }
        : state.settingsByThread,
      // Clear any transient fallback from the previous turn so the next message uses the intended model
      lastFallbackByThread: (() => {
        const next = { ...state.lastFallbackByThread };
        delete next[threadId];
        return next;
      })(),
      rateLimitByThread: (() => {
        const next = { ...state.rateLimitByThread };
        delete next[threadId];
        return next;
      })(),
      apiRetryByThread: (() => {
        const next = { ...state.apiRetryByThread };
        delete next[threadId];
        return next;
      })(),
      errorByThread: (() => {
        const next = { ...state.errorByThread };
        delete next[threadId];
        return next;
      })(),
    }));

    try {
      const { interactionMode } = get().getThreadSettings(threadId);
      await getTransport().sendMessage(
        threadId,
        content,
        model,
        permissionMode,
        attachments,
        displayContent,
        reasoningLevel,
        provider,
        interactionMode,
        copilotAgent,
        contextWindow,
        thinking,
        replyToMessageId,
        quotedText,
      );
    } catch (e) {
      set((state) => {
        const next = new Set(state.runningThreadIds);
        next.delete(threadId);
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        return { errorByThread: { ...state.errorByThread, [threadId]: String(e) }, runningThreadIds: next, agentStartTimes: nextStartTimes };
      });
    }
  },

  /** Request the agent to stop on a thread. Always marks the thread as not running, even on error. */
  stopAgent: async (threadId) => {
    let stopSucceeded = false;
    set((state) => ({
      awaitingUserStopPersistByThread: { ...state.awaitingUserStopPersistByThread, [threadId]: true },
    }));
    try {
      await getTransport().stopAgent(threadId);
      stopSucceeded = true;
    } catch (e) {
      set((state) => {
        const nextAwaiting = { ...state.awaitingUserStopPersistByThread };
        delete nextAwaiting[threadId];
        return {
          errorByThread: { ...state.errorByThread, [threadId]: String(e) },
          awaitingUserStopPersistByThread: nextAwaiting,
        };
      });
    }

    const snap = get();
    let lastUserText: string | null = null;
    if (snap.currentThreadId === threadId) {
      for (let i = snap.messages.length - 1; i >= 0; i--) {
        if (snap.messages[i].role === "user") {
          lastUserText = snap.messages[i].content;
          break;
        }
      }
    }

    set((state) => {
      const next = new Set(state.runningThreadIds);
      next.delete(threadId);
      const nextRateLimit = { ...state.rateLimitByThread };
      delete nextRateLimit[threadId];
      const nextApiRetry = { ...state.apiRetryByThread };
      delete nextApiRetry[threadId];
      const nextRecall =
        stopSucceeded && lastUserText !== null && state.currentThreadId === threadId
          ? { ...state.composerRecallFromStopByThread, [threadId]: { text: lastUserText } }
          : state.composerRecallFromStopByThread;
      return {
        runningThreadIds: next,
        rateLimitByThread: nextRateLimit,
        apiRetryByThread: nextApiRetry,
        composerRecallFromStopByThread: nextRecall,
      };
    });
  },

  hydrateRunningThreads: (ids) => {
    set((state) => {
      const current = state.runningThreadIds;
      // Short-circuit identical membership to preserve Set identity. Without
      // this guard, every WS reconnect allocates a new Set and re-renders all
      // subscribers (ChatView, Composer, ProjectTree, MessageList) even when
      // the running set hasn't changed.
      if (current.size === ids.length && ids.every((id) => current.has(id))) {
        return {};
      }
      // Seed agentStartTimes for ids that weren't previously tracked. Without
      // this, MessageList's "running for Xs" readout shows broken output until
      // the next server event arrives for each newly hydrated thread. Existing
      // entries (e.g. optimistic timestamps from a user-initiated send) are
      // preserved.
      const now = Date.now();
      const times = { ...state.agentStartTimes };
      for (const id of ids) {
        if (times[id] === undefined) times[id] = now;
      }
      return { runningThreadIds: new Set(ids), agentStartTimes: times };
    });
  },

  /** Append a single message to the current thread's message list. */
  addMessage: (message) => {
    set((state) => {
      const next = [...state.messages, message];
      const { messages: capped, evicted } = capMessages(next);
      return {
        messages: capped,
        ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
      };
    });
  },

  /**
   * Reset the shared message list and all ephemeral streaming state.
   * Does NOT reset runningThreadIds since agents may still be executing.
   */
  clearMessages: () => {
    flushPendingTextDeltas();
    const current = get().currentThreadId;
    if (current) evictMessageCache(current);

    get().toolCallRecordCache.clear();
    set((state) => ({
      messages: [],
      // Only prune state for the thread being unloaded. Background threads may
      // have streaming/tool-call/pagination state that must not be wiped here.
      ...(state.currentThreadId
        ? {
            errorByThread: omitKey(state.errorByThread, state.currentThreadId),
            streamingByThread: omitKey(state.streamingByThread, state.currentThreadId),
            streamingPreviewByThread: omitKey(state.streamingPreviewByThread, state.currentThreadId),
            toolCallsByThread: omitKey(state.toolCallsByThread, state.currentThreadId),
            currentTurnMessageIdByThread: omitKey(state.currentTurnMessageIdByThread, state.currentThreadId),
            oldestLoadedSequence: omitKey(state.oldestLoadedSequence, state.currentThreadId),
            hasMoreMessages: omitKey(state.hasMoreMessages, state.currentThreadId),
            isLoadingMore: omitKey(state.isLoadingMore, state.currentThreadId),
            loadEpochByThread: omitKey(state.loadEpochByThread, state.currentThreadId),
          }
        : {
            errorByThread: state.errorByThread,
            streamingByThread: state.streamingByThread,
            streamingPreviewByThread: state.streamingPreviewByThread,
            toolCallsByThread: state.toolCallsByThread,
            currentTurnMessageIdByThread: state.currentTurnMessageIdByThread,
            oldestLoadedSequence: state.oldestLoadedSequence,
            hasMoreMessages: state.hasMoreMessages,
            isLoadingMore: state.isLoadingMore,
            loadEpochByThread: state.loadEpochByThread,
          }),
      // Message-keyed maps belong to the visible thread only — always reset.
      persistedToolCallCounts: {},
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
      serverMessageIds: {},
    }));
    // Note: does NOT reset runningThreadIds - agents may still be running
  },

  /** Check whether an agent is currently executing on the given thread. */
  isThreadRunning: (threadId) => {
    return get().runningThreadIds.has(threadId);
  },

  /** Return per-thread settings, preferring in-memory overrides then DB-persisted values then defaults. */
  getThreadSettings: (threadId) => {
    const inMemory = get().settingsByThread[threadId];
    if (inMemory) return inMemory;

    // Hydrate from the thread's DB-persisted fields
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
    if (thread) {
      return {
        permissionMode: (thread.permission_mode as PermissionMode) ?? DEFAULT_THREAD_SETTINGS.permissionMode,
        interactionMode: (thread.interaction_mode as InteractionMode) ?? DEFAULT_THREAD_SETTINGS.interactionMode,
        reasoningLevel: thread.reasoning_level !== null
          ? (thread.reasoning_level as ReasoningLevel)
          : undefined,
        copilotAgent: thread.copilot_agent,
        contextWindow: (thread.context_window_mode as ContextWindowMode | null) ?? null,
        thinking: thread.thinking ?? null,
      };
    }

    return DEFAULT_THREAD_SETTINGS;
  },

  /**
   * Merge partial settings into the per-thread settings record and persist to the server.
   * Returns a Promise that resolves to true on success or false if the RPC fails.
   * undefined values in `settings` mean "don't change", not "clear".
   */
  setThreadSettings: (threadId, settings) => {
    // Build a clean patch with only explicitly-provided fields.
    // undefined means "don't change", not "clear". If we naively spread
    // settings, undefined values would overwrite the existing in-memory
    // state without being sent to the DB, causing divergence on reload.
    const patch: Partial<ThreadSettings> = {};
    if (settings.permissionMode !== undefined) patch.permissionMode = settings.permissionMode;
    if (settings.interactionMode !== undefined) patch.interactionMode = settings.interactionMode;
    if (settings.reasoningLevel !== undefined) patch.reasoningLevel = settings.reasoningLevel;
    // Use `in` check so explicit null clears the agent (null !== undefined).
    if ("copilotAgent" in settings) patch.copilotAgent = settings.copilotAgent;
    // null clears the override so the thread inherits from the global default.
    if ("contextWindow" in settings) patch.contextWindow = settings.contextWindow;
    if ("thinking" in settings) patch.thinking = settings.thinking;

    if (Object.keys(patch).length === 0) return Promise.resolve(false);

    set((state) => ({
      settingsByThread: {
        ...state.settingsByThread,
        [threadId]: { ...state.getThreadSettings(threadId), ...patch },
      },
    }));

    // Also mirror the patch into workspaceStore.threads so the cached
    // thread object stays in sync. Composer's no-draft hydration path
    // reads from that cache directly (permission_mode, interaction_mode,
    // reasoning_level, copilot_agent), so failing to sync here causes
    // the UI to revert to stale DB values on thread re-entry.
    useWorkspaceStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              ...(patch.permissionMode !== undefined && { permission_mode: patch.permissionMode }),
              ...(patch.interactionMode !== undefined && { interaction_mode: patch.interactionMode }),
              ...(patch.reasoningLevel !== undefined && { reasoning_level: patch.reasoningLevel }),
              ...("copilotAgent" in patch && { copilot_agent: patch.copilotAgent ?? null }),
              ...("contextWindow" in patch && { context_window_mode: patch.contextWindow ?? null }),
              ...("thinking" in patch && { thinking: patch.thinking ?? null }),
            }
          : t,
      ),
    }));

    // copilotAgent / contextWindow / thinking: null clears the persisted value; undefined means don't change.
    const transportPatch: {
      reasoningLevel?: ReturnType<typeof get>["settingsByThread"][string]["reasoningLevel"];
      interactionMode?: ReturnType<typeof get>["settingsByThread"][string]["interactionMode"];
      permissionMode?: ReturnType<typeof get>["settingsByThread"][string]["permissionMode"];
      copilotAgent?: string | null;
      contextWindow?: ContextWindowMode | null;
      thinking?: boolean | null;
    } = {
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
      ...(patch.reasoningLevel !== undefined ? { reasoningLevel: patch.reasoningLevel } : {}),
      ...("copilotAgent" in patch ? { copilotAgent: patch.copilotAgent } : {}),
      ...("contextWindow" in patch ? { contextWindow: patch.contextWindow } : {}),
      ...("thinking" in patch ? { thinking: patch.thinking } : {}),
    };
    return getTransport().updateThreadSettings(threadId, transportPatch).catch(() => false);
  },

  clearThreadState: (threadId) => {
    evictMessageCache(threadId);
    clearDequeueTimer(threadId);
    forgetScrollTop(threadId);

    // Capture before set() to avoid relying on the post-mutation state value.
    const isCurrentThread = get().currentThreadId === threadId;

    set((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      nextRunning.delete(threadId);

      return {
        runningThreadIds: nextRunning,
        errorByThread: omitKey(state.errorByThread, threadId),
        streamingByThread: omitKey(state.streamingByThread, threadId),
        streamingPreviewByThread: omitKey(state.streamingPreviewByThread, threadId),
        toolCallsByThread: omitKey(state.toolCallsByThread, threadId),
        agentStartTimes: omitKey(state.agentStartTimes, threadId),
        settingsByThread: omitKey(state.settingsByThread, threadId),
        currentTurnMessageIdByThread: omitKey(state.currentTurnMessageIdByThread, threadId),
        oldestLoadedSequence: omitKey(state.oldestLoadedSequence, threadId),
        hasMoreMessages: omitKey(state.hasMoreMessages, threadId),
        isLoadingMore: omitKey(state.isLoadingMore, threadId),
        loadEpochByThread: omitKey(state.loadEpochByThread, threadId),
        contextByThread: omitKey(state.contextByThread, threadId),
        isCompactingByThread: omitKey(state.isCompactingByThread, threadId),
        lastFallbackByThread: omitKey(state.lastFallbackByThread, threadId),
        rateLimitByThread: omitKey(state.rateLimitByThread, threadId),
        apiRetryByThread: omitKey(state.apiRetryByThread, threadId),
        planQuestionsByThread: omitKey(state.planQuestionsByThread, threadId),
        planAnswersByThread: omitKey(state.planAnswersByThread, threadId),
        activeQuestionIndexByThread: omitKey(state.activeQuestionIndexByThread, threadId),
        planQuestionsStatusByThread: omitKey(state.planQuestionsStatusByThread, threadId),
        answeredPlanMessageIdsByThread: omitKey(state.answeredPlanMessageIdsByThread, threadId),
        permissionsByThread: omitKey(state.permissionsByThread, threadId),
        hooksByThread: omitKey(state.hooksByThread, threadId),
        thoughtSegmentsByThread: omitKey(state.thoughtSegmentsByThread, threadId),
        usageByProvider: Object.fromEntries(
          Object.entries(state.usageByProvider).filter(([k]) => !k.startsWith(`${threadId}:`)),
        ),
        awaitingUserStopPersistByThread: omitKey(state.awaitingUserStopPersistByThread, threadId),
        interruptStopFileNoticeByThread: omitKey(state.interruptStopFileNoticeByThread, threadId),
        composerRecallFromStopByThread: omitKey(state.composerRecallFromStopByThread, threadId),
        // Clear message-keyed globals only when deleting the currently loaded thread.
        // For background threads, message-keyed maps (persistedToolCallCounts, etc.)
        // belong to the active thread's messages and must not be touched.
        ...(isCurrentThread
          ? {
              currentThreadId: null,
              messages: [],
              persistedToolCallCounts: {},
              persistedFilesChanged: {},
              serverMessageIds: {},
              latestTurnWithChanges: null,
            }
          : {}),
      };
    });

    // Evict tool call record cache when deleting the current thread.
    // Cache keys are message-based so we can't surgically prune by thread.
    // Use the pre-captured flag to avoid reading stale post-set() state.
    if (isCurrentThread) {
      get().toolCallRecordCache.clear();
    }
  },

  /**
   * Batch-prune per-thread state for multiple deleted threads in a single
   * Zustand set() call to avoid N sequential re-render batches.
   * Used by deleteWorkspace where many threads are removed at once.
   */
  clearThreadStateMany: (threadIds) => {
    if (threadIds.length === 0) return;

    for (const threadId of threadIds) {
      evictMessageCache(threadId);
      clearDequeueTimer(threadId);
      forgetScrollTop(threadId);
    }

    // Capture before set() to avoid relying on post-mutation state.
    const currentThreadId = get().currentThreadId;
    const deletingCurrentThread = currentThreadId !== null && threadIds.includes(currentThreadId);

    set((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      for (const threadId of threadIds) {
        nextRunning.delete(threadId);
      }

      // Prune every per-thread map for all deleted thread IDs in one pass.
      const pruneAll = <V>(rec: Record<string, V>): Record<string, V> => {
        const next = { ...rec };
        for (const tid of threadIds) delete next[tid];
        return next;
      };

      return {
        runningThreadIds: nextRunning,
        errorByThread: pruneAll(state.errorByThread),
        streamingByThread: pruneAll(state.streamingByThread),
        streamingPreviewByThread: pruneAll(state.streamingPreviewByThread),
        toolCallsByThread: pruneAll(state.toolCallsByThread),
        agentStartTimes: pruneAll(state.agentStartTimes),
        settingsByThread: pruneAll(state.settingsByThread),
        currentTurnMessageIdByThread: pruneAll(state.currentTurnMessageIdByThread),
        oldestLoadedSequence: pruneAll(state.oldestLoadedSequence),
        hasMoreMessages: pruneAll(state.hasMoreMessages),
        isLoadingMore: pruneAll(state.isLoadingMore),
        loadEpochByThread: pruneAll(state.loadEpochByThread),
        contextByThread: pruneAll(state.contextByThread),
        isCompactingByThread: pruneAll(state.isCompactingByThread),
        lastFallbackByThread: pruneAll(state.lastFallbackByThread),
        rateLimitByThread: pruneAll(state.rateLimitByThread),
        apiRetryByThread: pruneAll(state.apiRetryByThread),
        planQuestionsByThread: pruneAll(state.planQuestionsByThread),
        planAnswersByThread: pruneAll(state.planAnswersByThread),
        activeQuestionIndexByThread: pruneAll(state.activeQuestionIndexByThread),
        planQuestionsStatusByThread: pruneAll(state.planQuestionsStatusByThread),
        answeredPlanMessageIdsByThread: pruneAll(state.answeredPlanMessageIdsByThread),
        permissionsByThread: pruneAll(state.permissionsByThread),
        hooksByThread: pruneAll(state.hooksByThread),
        thoughtSegmentsByThread: pruneAll(state.thoughtSegmentsByThread),
        usageByProvider: Object.fromEntries(
          Object.entries(state.usageByProvider).filter(([k]) => !threadIds.some((tid) => k.startsWith(`${tid}:`))),
        ),
        awaitingUserStopPersistByThread: pruneAll(state.awaitingUserStopPersistByThread),
        interruptStopFileNoticeByThread: pruneAll(state.interruptStopFileNoticeByThread),
        composerRecallFromStopByThread: pruneAll(state.composerRecallFromStopByThread),
        ...(deletingCurrentThread
          ? {
              currentThreadId: null,
              messages: [],
              persistedToolCallCounts: {},
              persistedFilesChanged: {},
              serverMessageIds: {},
              latestTurnWithChanges: null,
            }
          : {}),
      };
    });

    if (deletingCurrentThread) {
      get().toolCallRecordCache.clear();
    }
  },

  setPlanQuestions: (threadId, questions) => {
    set((state) => ({
      planQuestionsByThread: { ...state.planQuestionsByThread, [threadId]: questions },
      planAnswersByThread: { ...state.planAnswersByThread, [threadId]: new Map() },
      activeQuestionIndexByThread: { ...state.activeQuestionIndexByThread, [threadId]: 0 },
      planQuestionsStatusByThread: { ...state.planQuestionsStatusByThread, [threadId]: "pending" },
    }));
  },

  setPlanAnswer: (threadId, questionId, answer) => {
    set((state) => {
      const existing = state.planAnswersByThread[threadId] ?? new Map<string, PlanAnswer>();
      const updated = new Map(existing);
      updated.set(questionId, answer);
      return {
        planAnswersByThread: { ...state.planAnswersByThread, [threadId]: updated },
      };
    });
  },

  setActiveQuestionIndex: (threadId, index) => {
    set((state) => ({
      activeQuestionIndexByThread: { ...state.activeQuestionIndexByThread, [threadId]: index },
    }));
  },

  submitPlanAnswers: async (threadId) => {
    const state = get();
    const answersMap = state.planAnswersByThread[threadId] ?? new Map<string, PlanAnswer>();
    const questions = state.planQuestionsByThread[threadId] ?? [];
    const { permissionMode, reasoningLevel, contextWindow, thinking } = state.getThreadSettings(threadId);

    // Build an answer for every question; unanswered questions get nulls
    const answers: PlanAnswer[] = questions.map((q) => {
      const a = answersMap.get(q.id);
      return a ?? { questionId: q.id, selectedOptionId: null, freeText: null };
    });

    // Hide the wizard and mark the thread running before the RPC so the
    // composer stays disabled for the entire continuation request, not just
    // after it resolves.
    set((s) => ({
      planQuestionsStatusByThread: { ...s.planQuestionsStatusByThread, [threadId]: "answered" },
      runningThreadIds: new Set([...s.runningThreadIds, threadId]),
      agentStartTimes: { ...s.agentStartTimes, [threadId]: Date.now() },
    }));

    try {
      await getTransport().answerPlanQuestions(
        threadId,
        answers,
        permissionMode,
        reasoningLevel,
        contextWindow ?? undefined,
        thinking ?? undefined,
      );
    } catch (e) {
      // Revert to pending on error so user can retry
      set((s) => ({
        planQuestionsStatusByThread: { ...s.planQuestionsStatusByThread, [threadId]: "pending" },
        runningThreadIds: new Set([...Array.from(s.runningThreadIds).filter((id) => id !== threadId)]),
        errorByThread: { ...s.errorByThread, [threadId]: String(e) },
      }));
    }
  },

  clearPlanQuestions: (threadId) => {
    set((state) => {
      const nextQuestions = { ...state.planQuestionsByThread };
      const nextAnswers = { ...state.planAnswersByThread };
      const nextIndex = { ...state.activeQuestionIndexByThread };
      const nextStatus = { ...state.planQuestionsStatusByThread };
      delete nextQuestions[threadId];
      delete nextAnswers[threadId];
      delete nextIndex[threadId];
      delete nextStatus[threadId];
      return {
        planQuestionsByThread: nextQuestions,
        planAnswersByThread: nextAnswers,
        activeQuestionIndexByThread: nextIndex,
        planQuestionsStatusByThread: nextStatus,
      };
    });
  },

  markPlanAnswered: (threadId, assistantMessageId) => {
    set((state) => {
      const existing =
        state.answeredPlanMessageIdsByThread[threadId] ?? new Set<string>();
      const nextSet = new Set(existing);
      nextSet.add(assistantMessageId);

      // Dismiss the wizard for the thread now that the round is settled.
      const nextQuestions = { ...state.planQuestionsByThread };
      const nextAnswers = { ...state.planAnswersByThread };
      const nextIndex = { ...state.activeQuestionIndexByThread };
      const nextStatus = { ...state.planQuestionsStatusByThread };
      delete nextQuestions[threadId];
      delete nextAnswers[threadId];
      delete nextIndex[threadId];
      delete nextStatus[threadId];

      return {
        answeredPlanMessageIdsByThread: {
          ...state.answeredPlanMessageIdsByThread,
          [threadId]: nextSet,
        },
        planQuestionsByThread: nextQuestions,
        planAnswersByThread: nextAnswers,
        activeQuestionIndexByThread: nextIndex,
        planQuestionsStatusByThread: nextStatus,
      };
    });
  },

  addPermissionRequest: (request) => {
    set((s) => {
      const existing = s.permissionsByThread[request.threadId] ?? [];
      // Guard against duplicate push events (e.g., IPC + WebSocket double delivery)
      if (existing.some((p) => p.requestId === request.requestId)) return s;
      return {
        permissionsByThread: {
          ...s.permissionsByThread,
          [request.threadId]: [...existing, { ...request, settled: false }],
        },
      };
    });
  },

  resolvePermissionRequest: (requestId, decision) => {
    set((s) => {
      const updated = { ...s.permissionsByThread };
      for (const threadId of Object.keys(updated)) {
        const list = updated[threadId];
        const idx = list?.findIndex((p) => p.requestId === requestId);
        if (idx !== undefined && idx >= 0 && list) {
          updated[threadId] = list.map((p, i) =>
            i === idx ? { ...p, settled: true, decision } : p,
          );
          break;
        }
      }
      return { permissionsByThread: updated };
    });
  },

  /**
   * Process a real-time agent event (sidecar or legacy CLI format).
   * Updates per-thread streaming text, tool calls, and running state.
   * On turn completion, commits any buffered streaming content as a
   * message and schedules tool call fade-out animations.
   */
  handleAgentEvent: (threadId, event) => {
    const method = (event.method as string) || "";
    const params = (event.params as Record<string, unknown>) || event;

    if (method !== "session.textDelta") {
      flushPendingTextDeltas();
    }

    // Only evict the message cache on structural changes that add or modify
    // persisted messages. Streaming deltas (textDelta, toolProgress) are
    // ephemeral and don't change what loadMessages would return from the DB.
    const isStructuralEvent =
      method === "session.turnComplete" ||
      method === "session.ended" ||
      method === "session.message" ||
      method === "session.error";
    if (isStructuralEvent) {
      evictMessageCache(threadId);
    }

    // Helper: mark all prior incomplete tool calls as complete.
    // The Claude Agent SDK handles tool execution internally and does not
    // emit standalone "session.toolResult" events. So when a new event
    // arrives that implies previous tools finished (new toolUse, message,
    // delta, or turnComplete), we mark prior calls as done.
    const markPriorToolCallsComplete = () => {
      const calls = get().toolCallsByThread[threadId];
      if (!calls || !calls.some((tc) => !tc.isComplete)) return;
      set((state) => {
        const current = state.toolCallsByThread[threadId] ?? [];
        // Agent calls complete only when they have at least one child and all
        // children are done. An Agent with no children yet is still in-flight -
        // leaving it incomplete preserves the live subagent UI. An Agent whose
        // children have all finished is implicitly done when a new top-level
        // event arrives (text, new tool, or message), because the Claude Agent
        // SDK does not always emit a toolResult for Agent calls.
        const children = (agentId: string) =>
          current.filter((c) => c.parentToolCallId === agentId);
        const isAgentDone = (agentId: string) => {
          const kids = children(agentId);
          return kids.length > 0 && !kids.some((c) => !c.isComplete);
        };

        const updated = current.map((tc) => {
          if (tc.isComplete) return tc;
          if (tc.toolName === "Agent") {
            return isAgentDone(tc.id) ? { ...tc, isComplete: true } : tc;
          }
          return { ...tc, isComplete: true };
        });
        return {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
      });
    };

    // -- Sidecar events (new format) --

    // Any non-retry event on this thread means a pending API retry resolved
    if (method !== "session.apiRetry" && get().apiRetryByThread[threadId]) {
      set((state) => {
        const next = { ...state.apiRetryByThread };
        delete next[threadId];
        return { apiRetryByThread: next };
      });
    }

    if (method === "session.system") {
      const subtype = params.subtype as string;
      if (subtype === "session_restarted") {
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "system",
          content: "Session restarted. The agent no longer has context from earlier messages.",
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          timestamp: new Date().toISOString(),
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          if (state.currentThreadId !== threadId) return {};
          const { messages: capped, evicted } = capMessages([...state.messages, message]);
          return {
            messages: capped,
            ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
          };
        });
      }
      return;
    }

    if (method === "session.turnStarted") {
      set((state) => {
        // Guard preserves the optimistic agentStartTimes[threadId] written by
        // sendMessage(). For server-originated turns (headless, reconnect), this
        // path is skipped and the timestamp is written fresh below.
        if (state.runningThreadIds.has(threadId)) return {};
        const next = new Set(state.runningThreadIds);
        next.add(threadId);
        return { runningThreadIds: next, agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() } };
      });
      // Clear interrupted status so the resume banner no longer lists this
      // thread while the agent processes the continuation message.
      useWorkspaceStore.setState((ws) => {
        const idx = ws.threads.findIndex(
          (t) => t.id === threadId && t.status === "interrupted",
        );
        if (idx < 0) return ws;
        const threads = [...ws.threads];
        threads[idx] = { ...threads[idx], status: "active" as const };
        return { threads };
      });
      return;
    }

    if (method === "session.message") {
      markPriorToolCallsComplete();
      const content = (params.content as string) || "";
      if (content) {
        const message: Message = {
          id: (params.messageId as string) || crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: (params.tokens as number) ?? null,
          timestamp: new Date().toISOString(),
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          // Clear streaming text so turnComplete won't duplicate this message.
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const trackTurn = {
            currentTurnMessageIdByThread: {
              ...state.currentTurnMessageIdByThread,
              [threadId]: message.id,
            },
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
          };
          if (state.currentThreadId !== threadId) return trackTurn;
          // In Electron, MessagePort and WebSocket are independent channels
          // with no ordering guarantee. Skip if already in messages to prevent
          // duplicates when both channels deliver the same message.
          if (state.messages.some((m) => m.id === message.id)) return trackTurn;
          const last = state.messages[state.messages.length - 1];
          if (
            last?.role === "assistant" &&
            last.content === content &&
            last.id !== message.id
          ) {
            const previousId = last.id;
            const nextPersistedToolCallCounts = { ...state.persistedToolCallCounts };
            if (previousId in nextPersistedToolCallCounts) {
              const tc = nextPersistedToolCallCounts[previousId];
              nextPersistedToolCallCounts[message.id] = tc;
              delete nextPersistedToolCallCounts[previousId];
            }

            const nextPersistedFilesChanged = { ...state.persistedFilesChanged };
            if (previousId in nextPersistedFilesChanged) {
              const fc = nextPersistedFilesChanged[previousId];
              nextPersistedFilesChanged[message.id] = fc;
              delete nextPersistedFilesChanged[previousId];
            }

            const nextServerMessageIds = { ...state.serverMessageIds };
            if (previousId in nextServerMessageIds) {
              const sid = nextServerMessageIds[previousId];
              nextServerMessageIds[message.id] = sid;
              delete nextServerMessageIds[previousId];
            }

            const replaced = state.messages.slice(0, -1).concat({
              ...last,
              id: message.id,
              tokens_used: message.tokens_used,
              timestamp: message.timestamp,
            });
            const { messages: capped, evicted } = capMessages(replaced);
            return {
              messages: capped,
              persistedToolCallCounts: nextPersistedToolCallCounts,
              persistedFilesChanged: nextPersistedFilesChanged,
              serverMessageIds: nextServerMessageIds,
              latestTurnWithChanges:
                state.latestTurnWithChanges === previousId ? message.id : state.latestTurnWithChanges,
              ...(evicted && state.currentThreadId
                ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } }
                : {}),
              ...trackTurn,
            };
          }
          const { messages: capped, evicted } = capMessages([...state.messages, message]);
          return {
            messages: capped,
            ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
            ...trackTurn,
          };
        });
      }
      return;
    }

    if (method === "session.toolUse") {
      const toolCallId = (params.toolCallId as string) || "";
      const existingCalls = get().toolCallsByThread[threadId] ?? [];
      if (toolCallId && existingCalls.some((tc) => tc.id === toolCallId)) {
        return;
      }

      const parentToolCallId = params.parentToolCallId as string | undefined;

      // Only mark prior tool calls complete if this isn't a subagent's tool call
      // (subagent calls should not mark the parent Agent call as complete)
      if (!parentToolCallId) {
        markPriorToolCallsComplete();
      }
      const toolName = (params.toolName as string) || "unknown";

      // Intercept TodoWrite calls to populate the task panel
      if (toolName === "TodoWrite") {
        const toolInput = (params.toolInput as Record<string, unknown>) || {};
        const todos = toolInput.todos as Array<Record<string, unknown>> | undefined;
        if (todos && Array.isArray(todos)) {
          const taskItems: TaskItem[] = todos.map((t, i) => ({
            // Prefer SDK-provided stable id; fall back to index-based surrogate
            id: t.id != null ? String(t.id) : String(i),
            content: String(t.content ?? ""),
            status: coerceTaskStatus(t.status),
            group: "Tasks",
          }));
          useTaskStore.getState().setTasks(threadId, taskItems);
        }
      }

      const toolCall: ToolCall = {
        id: toolCallId || crypto.randomUUID(),
        toolName,
        toolInput: (params.toolInput as Record<string, unknown>) || {},
        output: null,
        isError: false,
        isComplete: false,
        parentToolCallId: parentToolCallId || undefined,
        startedAt: Date.now(),
      };
      set((state) => {
        // Freeze the active thought segment so it has a definite end time.
        const segments = state.thoughtSegmentsByThread[threadId] ?? [];
        const last = segments[segments.length - 1];
        const nextSegments =
          last && last.endedAt === undefined
            ? {
                ...state.thoughtSegmentsByThread,
                [threadId]: [
                  ...segments.slice(0, -1),
                  { ...last, endedAt: Date.now() },
                ],
              }
            : state.thoughtSegmentsByThread;
        return {
          toolCallsByThread: {
            ...state.toolCallsByThread,
            [threadId]: [...(state.toolCallsByThread[threadId] ?? []), toolCall],
          },
          thoughtSegmentsByThread: nextSegments,
        };
      });
      return;
    }

    if (method === "session.toolResult") {
      const toolCallId = (params.toolCallId as string) || "";
      const output = (params.output as string) || "";
      const isError = (params.isError as boolean) || false;
      set((state) => {
        const calls = state.toolCallsByThread[threadId] ?? [];
        // Try matching by ID first; fall back to the first incomplete tool call
        // when the SDK sends a null or non-matching toolCallId.
        const hasIdMatch = toolCallId && calls.some((tc) => tc.id === toolCallId);

        // Fallback: pick the first incomplete call, but never pick an Agent call
        // that has active children — completing it prematurely would hide nested work.
        const hasActiveChildren = (id: string) =>
          calls.some((c) => c.parentToolCallId === id && !c.isComplete);
        let matched = false;
        const updated = hasIdMatch
          ? calls.map((tc) =>
              tc.id === toolCallId ? { ...tc, output, isError, isComplete: true } : tc
            )
          : calls.map((tc) => {
              if (!matched && !tc.isComplete && !(tc.toolName === "Agent" && hasActiveChildren(tc.id))) {
                matched = true;
                return { ...tc, output, isError, isComplete: true };
              }
              return tc;
            });

        return {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
      });
      return;
    }

    // session.textDelta: accumulate streaming text for live preview and finalization.
    if (method === "session.textDelta") {
      const delta = (params.delta as string) || "";
      if (!delta) return;
      const hadPending = pendingTextDeltaByThread.has(threadId);
      pendingTextDeltaByThread.set(
        threadId,
        (pendingTextDeltaByThread.get(threadId) ?? "") + delta,
      );
      if (!hadPending) {
        markPriorToolCallsComplete();
      }
      scheduleTextDeltaFlush();
      return;
    }

    if (method === "session.toolProgress") {
      const toolCallId = (params.toolCallId as string) || "";
      const elapsedSeconds = (params.elapsedSeconds as number) ?? 0;
      if (!toolCallId) return;
      set((state) => {
        const current = state.toolCallsByThread[threadId] ?? [];
        let changed = false;
        const updated = current.map((tc) => {
          if (tc.id === toolCallId && !tc.isComplete && tc.elapsedSeconds !== elapsedSeconds) {
            changed = true;
            return { ...tc, elapsedSeconds };
          }
          return tc;
        });
        // Return same state reference when nothing changed — Zustand skips notification.
        if (!changed) return state;
        return {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
      });
      return;
    }

    if (method === "session.hookStarted") {
      const hookName = (params.hookName as string) || "unknown";
      const hookType = (params.hookType as "permission" | "stop") || "stop";
      const toolName = params.toolName as string | undefined;
      const hook: HookExecution = {
        hookName,
        hookType,
        toolName,
        status: "running",
        outputLines: [],
        fullOutput: [],
        startedAt: Date.now(),
      };
      set((state) => ({
        hooksByThread: {
          ...state.hooksByThread,
          [threadId]: [...(state.hooksByThread[threadId] ?? []), hook],
        },
      }));
      return;
    }

    if (method === "session.hookProgress") {
      const hookName = (params.hookName as string) || "";
      const output = (params.output as string) || "";
      if (!hookName || !output) return;
      set((state) => {
        const hooks = state.hooksByThread[threadId] ?? [];
        // Target the last running hook with this name (not all same-name runs)
        let idx = -1;
        for (let i = hooks.length - 1; i >= 0; i--) {
          if (hooks[i]!.hookName === hookName && hooks[i]!.status === "running") {
            idx = i;
            break;
          }
        }
        if (idx < 0) return state;
        // Split chunk into actual lines so the 20-line cap is line-based
        const addedLines = output
          .split(/\r?\n/)
          .filter((line, i, arr) => !(i === arr.length - 1 && line === ""));
        if (addedLines.length === 0) return state;
        const next = [...hooks];
        const target = next[idx]!;
        // Cap retained output to prevent unbounded memory growth from verbose hooks
        const raw = [...target.fullOutput, ...addedLines];
        const fullOutput = raw.length > 500 ? raw.slice(-500) : raw;
        next[idx] = { ...target, fullOutput, outputLines: fullOutput.slice(-20) };
        return { hooksByThread: { ...state.hooksByThread, [threadId]: next } };
      });
      return;
    }

    if (method === "session.hookCompleted") {
      const hookName = (params.hookName as string) || "";
      const exitCode = (params.exitCode as number) ?? 1;
      const durationMs = (params.durationMs as number) ?? 0;
      const didBlock = (params.didBlock as boolean) ?? false;
      if (!hookName) return;
      set((state) => {
        const hooks = state.hooksByThread[threadId] ?? [];
        // Target the last running hook with this name
        let idx = -1;
        for (let i = hooks.length - 1; i >= 0; i--) {
          if (hooks[i]!.hookName === hookName && hooks[i]!.status === "running") {
            idx = i;
            break;
          }
        }
        if (idx < 0) return state;
        const next = [...hooks];
        next[idx] = { ...next[idx]!, status: "completed" as const, exitCode, durationMs, didBlock };
        return { hooksByThread: { ...state.hooksByThread, [threadId]: next } };
      });
      return;
    }

    if (method === "session.turnComplete" || method === "session.ended") {
      const costUsd = (params.costUsd as number) ?? null;
      const tokensIn = ((params.tokensIn as number) ?? (params.totalTokensIn as number)) ?? 0;
      const tokensOut = ((params.tokensOut as number) ?? (params.totalTokensOut as number)) ?? 0;

      // Commit any remaining streaming content and stop the agent,
      // Tool calls remain in-place and collapse into a summary.
      const streamContent = get().streamingByThread[threadId] ?? "";

      // Build an ephemeral system message for guardrail stops (budget/turn limit).
      // Folded into the same set() call to avoid a double render pass.
      const reason = method === "session.turnComplete" ? params.reason as string | undefined : undefined;
      const isGuardrailStop = reason === "error_max_budget_usd" || reason === "max_turns";
      const guardrailMsg: Message | null = isGuardrailStop ? {
        id: crypto.randomUUID(),
        thread_id: threadId,
        role: "system",
        content: `Agent stopped: ${reason === "error_max_budget_usd" ? "Budget cap reached" : "Max turns reached"}. You can adjust guardrails in Settings > Agent.`,
        sequence: 0,
        tokens_used: null,
        cost_usd: null,
        timestamp: new Date().toISOString(),
        tool_calls: null,
        files_changed: null,
        attachments: null,
      } : null;

      // First: mark all tool calls as complete (in place) and commit the message
      if (streamContent) {
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content: streamContent,
          tool_calls: null,
          files_changed: null,
          cost_usd: costUsd,
          tokens_used: tokensIn + tokensOut || null,
          timestamp: new Date().toISOString(),
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          // Mark all tool calls as complete and keep in active slot briefly
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          const dedupedGuardrail = guardrailMsg && !state.messages.some(
            (m) => m.role === "system" && m.content.startsWith("Agent stopped:"),
          ) ? guardrailMsg : null;
          const pending = [message, ...(dedupedGuardrail ? [dedupedGuardrail] : [])];
          return {
            ...(state.currentThreadId === threadId
              ? (() => {
                  const { messages: capped, evicted } = capMessages([...state.messages, ...pending]);
                  return { messages: capped, ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}) };
                })()
              : {}),
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
            runningThreadIds: nextRunning,
            agentStartTimes: nextStartTimes,
            toolCallsByThread: completedCalls.length > 0
              ? { ...state.toolCallsByThread, [threadId]: completedCalls }
              : state.toolCallsByThread,
            // Clear thought segments now that the turn is complete.
            thoughtSegmentsByThread: omitKey(state.thoughtSegmentsByThread, threadId),
            // Clear permission cards now that the agent has responded.
            permissionsByThread: (() => {
              const next = { ...state.permissionsByThread };
              delete next[threadId];
              return next;
            })(),
            rateLimitByThread: (() => {
              const next = { ...state.rateLimitByThread };
              delete next[threadId];
              return next;
            })(),
          };
        });
      } else {
        set((state) => {
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          const dedupedGuardrail = guardrailMsg && !state.messages.some(
            (m) => m.role === "system" && m.content.startsWith("Agent stopped:"),
          ) ? guardrailMsg : null;
          return {
            ...(dedupedGuardrail && state.currentThreadId === threadId
              ? (() => {
                  const { messages: capped, evicted } = capMessages([...state.messages, dedupedGuardrail]);
                  return { messages: capped, ...(evicted ? { hasMoreMessages: { ...state.hasMoreMessages, [threadId]: true } } : {}) };
                })()
              : {}),
            runningThreadIds: nextRunning,
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
            agentStartTimes: nextStartTimes,
            toolCallsByThread: completedCalls.length > 0
              ? { ...state.toolCallsByThread, [threadId]: completedCalls }
              : state.toolCallsByThread,
            // Clear thought segments now that the turn is complete.
            thoughtSegmentsByThread: omitKey(state.thoughtSegmentsByThread, threadId),
            // Clear permission cards now that the agent has responded.
            permissionsByThread: (() => {
              const next = { ...state.permissionsByThread };
              delete next[threadId];
              return next;
            })(),
            rateLimitByThread: (() => {
              const next = { ...state.rateLimitByThread };
              delete next[threadId];
              return next;
            })(),
          };
        });
      }

      // Update context tracker. Prefer the SDK-reported contextWindow (authoritative)
      // over the local registry. The DB is updated server-side; contextByThread is
      // the live source within a session and loaded from thread.list on cold start.
      //
      // Skip context update if the thread is currently compacting. A turnComplete
      // can fire during compaction (from the compaction API call itself) carrying
      // the pre-compaction input token count, which would flash near-100% fill.
      // Compaction cleanup (isCompactingByThread) is handled solely by the
      // session.compacting handler to keep lifecycle management in one place.
      if (tokensIn > 0 && !get().isCompactingByThread[threadId]) {
        const sdkContextWindow = params.contextWindow as number | undefined;
        const totalProcessedTokens = params.totalProcessedTokens as number | undefined;
        // Prefer the actual model that ran (post-fallback) so context window
        // sizing reflects Haiku's limits rather than the requested Opus model.
        const fallback = get().lastFallbackByThread[threadId];
        const thread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
        const modelId = fallback?.actualModel
          ?? thread?.model
          ?? "claude-sonnet-4-6";
        // Effective mode chain: thread override > settings default > "200k".
        // Uses get() (not state) because this runs outside the set() callback.
        const settingsDefaults = useSettingsStore.getState().settings.model.defaults;
        const effectiveMode: ContextWindowMode =
          (thread?.context_window_mode as ContextWindowMode | null | undefined)
          ?? settingsDefaults.contextWindow
          ?? "200k";
        const contextWindow = resolveContextWindow({
          sdkContextWindow,
          modelId,
          contextWindowMode: effectiveMode,
          previousContextWindow: get().contextByThread[threadId]?.contextWindow,
        });
        set((state) => ({
          contextByThread: {
            ...state.contextByThread,
            [threadId]: {
              lastTokensIn: tokensIn,
              contextWindow,
              totalProcessedTokens,
              tokensOut,
              cacheReadTokens: params.cacheReadTokens as number | undefined,
              cacheWriteTokens: params.cacheWriteTokens as number | undefined,
              costMultiplier: params.costMultiplier as number | undefined,
            },
          },
        }));
      }

      // Tool calls remain in state (all marked complete). They render as
      // a collapsed summary in-place. When turn.persisted fires, the DB-backed
      // summary replaces them and tool calls are cleared.

      // Sync the thread's status in workspaceStore so the sidebar shows
      // the green "Completed" badge without waiting for a full thread reload.
      // If the user is already viewing this thread, skip the badge and
      // immediately mark viewed so the DB transitions to "paused".
      const isActiveThread = useWorkspaceStore.getState().activeThreadId === threadId;
      if (isActiveThread) {
        getTransport().markThreadViewed(threadId).catch(() => {});
      } else {
        useWorkspaceStore.setState((ws) => ({
          threads: ws.threads.map((t) =>
            t.id === threadId ? { ...t, status: "completed" as const } : t,
          ),
        }));
      }

      // Auto-dequeue: send next queued message after a brief visual pause.
      // Only on turnComplete (not session.ended) so explicit stops don't drain the queue.
      // Uses tracked timers to prevent double-dequeue from duplicate events.
      // Skip dequeue when a guardrail stopped the session to avoid restarting
      // an agent that was intentionally capped by budget or turn limits.
      if (method === "session.turnComplete" && !isGuardrailStop) {
        clearDequeueTimer(threadId);
        const timer = setTimeout(() => {
          dequeueTimers.delete(threadId);
          // Guard: verify the thread still exists and isn't already running
          const threadExists = useWorkspaceStore.getState().threads.some(
            (t) => t.id === threadId && t.deleted_at == null,
          );
          if (!threadExists) return;
          if (get().runningThreadIds.has(threadId)) return;

          // Skip auto-drain while the user is editing a queued message.
          // The queue will resume when the edit is saved or cancelled.
          if (useQueueStore.getState().editingThreadId === threadId) return;

          const next = useQueueStore.getState().dequeueNext(threadId);
          if (next) {
            void (async (): Promise<void> => {
              try {
                await get().sendMessage(
                  threadId,
                  next.content,
                  next.model,
                  next.permissionMode,
                  next.attachments.length > 0 ? next.attachments : undefined,
                  next.displayContent,
                  next.reasoningLevel,
                  next.provider,
                  next.copilotAgent,
                  next.contextWindow,
                  next.thinking,
                  next.replyToMessageId,
                  next.quotedText,
                );
              } catch {
                void releaseBrowserCaptureSpills(next.browserCaptureSpillPaths ?? []);
              }
            })();
          }
        }, 400);
        dequeueTimers.set(threadId, timer);
      }
      return;
    }

    if (method === "session.quotaUpdate") {
      const providerId = params.providerId as string;
      const categories = Array.isArray(params.categories)
        ? (params.categories as QuotaCategory[])
        : [];
      const sessionCostUsd = params.sessionCostUsd as number | undefined;
      const serviceTier = params.serviceTier as "standard" | "priority" | "batch" | undefined;
      const numTurns = params.numTurns as number | undefined;
      const durationMs = params.durationMs as number | undefined;
      if (providerId) {
        const key = `${threadId}:${providerId}`;
        set((state) => {
          const existing = state.usageByProvider[key];
          return {
            usageByProvider: {
              ...state.usageByProvider,
              [key]: {
                providerId,
                quotaCategories: categories.length > 0 ? categories : (existing?.quotaCategories ?? []),
                sessionCostUsd: sessionCostUsd ?? existing?.sessionCostUsd,
                serviceTier: serviceTier ?? existing?.serviceTier,
                numTurns: numTurns ?? existing?.numTurns,
                durationMs: durationMs ?? existing?.durationMs,
              },
            },
          };
        });
        // The QuotaUpdate event reports session-level deltas (cost, turns, duration).
        // Plan utilization moves on the same edge, so re-fetch the provider snapshot
        // to pick up fresh 5-hour / weekly numbers without forcing the user to hover.
        get().fetchProviderUsage(threadId, providerId);
      }
      return;
    }

    if (method === "session.contextEstimate") {
      const tokensIn = params.tokensIn as number;
      const ctxWindow = params.contextWindow as number | undefined;
      // Only apply if not compacting — the compaction-start zero sentinel is
      // authoritative while compaction is in progress.
      if (tokensIn > 0 && !get().isCompactingByThread[threadId]) {
        set((state) => {
          const prev = state.contextByThread[threadId];
          return {
            contextByThread: {
              ...state.contextByThread,
              [threadId]: {
                ...prev,
                lastTokensIn: tokensIn,
                contextWindow: ctxWindow ?? prev?.contextWindow,
                totalProcessedTokens: prev?.totalProcessedTokens,
              },
            },
          };
        });
      }
      return;
    }

    if (method === "session.rateLimited") {
      const active = params.active as boolean;
      set((state) => {
        const next = { ...state.rateLimitByThread };
        if (active) {
          next[threadId] = {
            retryAfterMs: params.retryAfterMs as number | undefined,
            limitType: params.limitType as string | undefined,
            utilization: params.utilization as number | undefined,
          };
        } else {
          delete next[threadId];
        }
        return { rateLimitByThread: next };
      });
      return;
    }

    if (method === "session.apiRetry") {
      set((state) => ({
        apiRetryByThread: {
          ...state.apiRetryByThread,
          [threadId]: {
            reason: params.reason as string,
            attempt: params.attempt as number | undefined,
            maxRetries: params.maxRetries as number | undefined,
            delayMs: params.delayMs as number | undefined,
          },
        },
      }));
      return;
    }

    if (method === "session.compacting") {
      const active = params.active as boolean;
      if (!active) {
        // Only add the system divider if the thread was actually marked as
        // compacting AND this is the currently loaded thread. addMessage appends
        // to the shared messages array, so inserting on a background thread
        // would show the divider in the wrong chat.
        const wasCompacting = get().isCompactingByThread[threadId] ?? false;
        if (wasCompacting && get().currentThreadId === threadId) {
          const systemMsg: Message = {
            id: crypto.randomUUID(),
            thread_id: threadId,
            role: "system",
            content: "Context compacted",
            sequence: get().messages.length + 1,
            timestamp: new Date().toISOString(),
            tool_calls: null,
            files_changed: null,
            cost_usd: null,
            tokens_used: null,
            attachments: null,
          };
          get().addMessage(systemMsg);
        }
      }
      set((state) => {
        const next = { ...state.isCompactingByThread };
        if (active) {
          next[threadId] = true;
        } else {
          delete next[threadId];
        }
        // When compaction starts, replace the live context entry with a zero
        // sentinel so the ring hides. Deleting the key would let the UI fall
        // back to the stale persisted value from the thread record.
        // When active=false, leave contextByThread untouched: the post-compaction
        // turnComplete may have already written fresh data.
        const prev = state.contextByThread[threadId];
        const nextCtx = active
          ? {
              ...state.contextByThread,
              [threadId]: { ...prev, lastTokensIn: 0, contextWindow: prev?.contextWindow, totalProcessedTokens: prev?.totalProcessedTokens },
            }
          : state.contextByThread;
        return { isCompactingByThread: next, contextByThread: nextCtx };
      });
      return;
    }

    if (method === "session.modelFallback") {
      const requestedModel = params.requestedModel as string;
      const actualModel = params.actualModel as string;

      // Normalize dated SDK variants (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
      const actualDefinition = findModelById(actualModel);
      const normalizedActual = actualDefinition?.id ?? actualModel;

      // Store as transient fallback info — do NOT mutate thread.model
      set((state) => ({
        lastFallbackByThread: {
          ...state.lastFallbackByThread,
          [threadId]: { requestedModel, actualModel: normalizedActual },
        },
      }));

      // Only notify the user if they are viewing this thread
      if (useWorkspaceStore.getState().activeThreadId === threadId) {
        const actualLabel = actualDefinition?.label ?? normalizedActual;
        const requestedLabel = findModelById(requestedModel)?.label ?? requestedModel;
        useToastStore.getState().show(
          "info",
          `Switched to ${actualLabel}`,
          `${requestedLabel} was unavailable`,
        );
      }
      return;
    }

    if (method === "session.error") {
      const errorMsg = typeof params.error === "string" ? params.error : String(params.error ?? "Unknown error");
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        role: "system",
        content: JSON.stringify({ __type: "agent_error", message: errorMsg }),
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date().toISOString(),
        sequence: get().messages.length + 1,
        attachments: null,
      };
      set((state) => {
        const nextRunning = new Set(state.runningThreadIds);
        nextRunning.delete(threadId);
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        const nextPreview = { ...state.streamingPreviewByThread };
        delete nextPreview[threadId];
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        const nextToolCalls = { ...state.toolCallsByThread };
        delete nextToolCalls[threadId];
        const nextCompacting = { ...state.isCompactingByThread };
        delete nextCompacting[threadId];
        const nextRateLimit = { ...state.rateLimitByThread };
        delete nextRateLimit[threadId];
        const nextApiRetry = { ...state.apiRetryByThread };
        delete nextApiRetry[threadId];
        const base = {
          errorByThread: { ...state.errorByThread, [threadId]: errorMsg },
          runningThreadIds: nextRunning,
          streamingByThread: nextStreaming,
          streamingPreviewByThread: nextPreview,
          agentStartTimes: nextStartTimes,
          toolCallsByThread: nextToolCalls,
          isCompactingByThread: nextCompacting,
          rateLimitByThread: nextRateLimit,
          apiRetryByThread: nextApiRetry,
        };
        if (state.currentThreadId !== threadId) return base;
        const { messages: capped, evicted } = capMessages([...state.messages, errorMessage]);
        return {
          ...base,
          messages: capped,
          ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
        };
      });

      // Clear any pending dequeue timer and queue for this thread on error
      clearDequeueTimer(threadId);
      useQueueStore.getState().clearQueue(threadId);

      // Sync the thread's status in workspaceStore so the sidebar shows
      // the red "Errored" badge without waiting for a full thread reload.
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, status: "errored" as const } : t,
        ),
      }));
      return;
    }

  },

  /**
   * Fetch provider usage from the server and merge it into usageByProvider.
   * Silently ignores errors so the popover shows stale or empty state rather than crashing.
   */
  fetchProviderUsage: async (threadId, providerId) => {
    try {
      const usage = await getTransport().getProviderUsage(providerId);
      const key = `${threadId}:${providerId}`;
      set((state) => ({
        usageByProvider: {
          ...state.usageByProvider,
          [key]: { ...state.usageByProvider[key], ...usage },
        },
      }));
    } catch {
      // Silently fail — popover shows stale or empty state
    }
  },

  clearInterruptStopFileNotice: (threadId) => {
    set((state) => ({
      interruptStopFileNoticeByThread: omitKey(state.interruptStopFileNoticeByThread, threadId),
    }));
  },

  clearComposerRecallFromStop: (threadId) => {
    set((state) => ({
      composerRecallFromStopByThread: omitKey(state.composerRecallFromStopByThread, threadId),
    }));
  },

  handleTurnPersisted: (payload) => {
    flushPendingTextDeltas();
    evictMessageCache(payload.threadId);

    set((state) => {
      const nextAwaiting = { ...state.awaitingUserStopPersistByThread };
      const nextNotice = { ...state.interruptStopFileNoticeByThread };
      if (nextAwaiting[payload.threadId]) {
        delete nextAwaiting[payload.threadId];
        if (payload.filesChanged.length > 0) {
          nextNotice[payload.threadId] = { paths: payload.filesChanged };
        }
      }

      // Clear in-memory tool calls now that the DB-backed summary takes over
      const nextToolCalls = { ...state.toolCallsByThread };
      delete nextToolCalls[payload.threadId];

      // The server's messageId may differ from the client's in-memory UUID
      // (client generates its own via crypto.randomUUID()). Prefer the ID
      // tracked during the active turn; fall back to the last assistant message
      // for cases where session.message arrived before tracking was introduced.
      let localMsgId = payload.messageId;
      const trackedMsgId = state.currentTurnMessageIdByThread[payload.threadId];
      if (trackedMsgId) {
        localMsgId = trackedMsgId;
      } else if (state.currentThreadId === payload.threadId) {
        // Fallback: find last assistant message (covers cases where session.message
        // arrived before we started tracking, e.g. on initial load).
        // Tail-scan to avoid copying the array just to reverse it.
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === "assistant") {
            localMsgId = state.messages[i].id;
            break;
          }
        }
      }

      const nextTurnMsgIds = { ...state.currentTurnMessageIdByThread };
      delete nextTurnMsgIds[payload.threadId];
      return {
        toolCallsByThread: nextToolCalls,
        persistedToolCallCounts: {
          ...state.persistedToolCallCounts,
          [localMsgId]: payload.toolCallCount,
        },
        persistedFilesChanged: {
          ...state.persistedFilesChanged,
          [localMsgId]: payload.filesChanged,
        },
        // Only update latestTurnWithChanges for the active thread — background
        // thread completions must not collapse the active thread's latest banner.
        latestTurnWithChanges:
          state.currentThreadId === payload.threadId
            ? payload.filesChanged.length > 0 ? localMsgId : null
            : state.latestTurnWithChanges,
        serverMessageIds: {
          ...state.serverMessageIds,
          [localMsgId]: payload.messageId,
        },
        currentTurnMessageIdByThread: nextTurnMsgIds,
        interruptStopFileNoticeByThread: nextNotice,
        awaitingUserStopPersistByThread: nextAwaiting,
      };
    });

    if (payload.filesChanged.length > 0) {
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === payload.threadId && !t.has_file_changes
            ? { ...t, has_file_changes: true }
            : t,
        ),
      }));
    }
  },
  };
});

/**
 * Returns true if the given thread has any unsettled permission requests.
 * Use inside components: `useThreadStore(s => hasPendingPermissions(s, threadId))`.
 */
export function hasPendingPermissions(state: ThreadState, threadId: string): boolean {
  const perms = state.permissionsByThread[threadId];
  return perms != null && perms.some((p) => !p.settled);
}
