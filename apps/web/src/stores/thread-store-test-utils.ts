import type { Message, ToolCall, HookExecution } from "@/transport";
import type { ThoughtSegment } from "@/components/chat/narrative/types";
import type { PlanQuestion, PlanAnswer, ProviderUsageInfo } from "@mcode/contracts";
import { LruCache } from "@/lib/lru-cache";
import { useThreadStore, TOOL_CALL_CACHE_SIZE } from "./threadStore";
import {
  createEmptyThreadRecord,
  patchThreadRecord,
  type HandoffMeta,
  type StoredPermission,
  type ThreadForkMode,
  type ThreadRecord,
  type ThreadSettings,
} from "./thread-record";

/** Default empty thread-store slice for unit tests. */
export function createEmptyThreadStoreState() {
  return {
    records: new Map<string, ThreadRecord>(),
    currentThreadId: null as string | null,
    runningThreadIds: new Set<string>(),
    toolCallRecordCache: new LruCache<string, import("@/transport").ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
    recentlyAnsweredPlanMessageIds: new Set<string>(),
  };
}

/**
 * Seed one thread record in the store for tests.
 * Returns the patched record map for optional chaining into setState.
 */
export function seedThreadRecord(
  threadId: string,
  patch: Partial<ThreadRecord> = {},
): Map<string, ThreadRecord> {
  const state = useThreadStore.getState();
  return patchThreadRecord(state.records, threadId, patch);
}

/** Reset thread store to an empty baseline, optionally seeding one active thread. */
export function resetThreadStoreForTests(opts?: {
  currentThreadId?: string | null;
  records?: Map<string, ThreadRecord>;
}) {
  useThreadStore.setState({
    ...createEmptyThreadStoreState(),
    currentThreadId: opts?.currentThreadId ?? null,
    records: opts?.records ?? new Map(),
  });
}

/** Read a field from an existing thread record; undefined when the thread is absent. */
function readExistingThreadField<T>(
  threadId: string,
  selector: (record: ThreadRecord) => T,
): T | undefined {
  const rec = useThreadStore.getState().records.get(threadId);
  if (!rec) return undefined;
  return selector(rec);
}

/** Read a field from a thread record in tests (non-subscribing). */
export function readThreadField<T>(
  threadId: string,
  selector: (record: ThreadRecord) => T,
): T {
  const rec = useThreadStore.getState().records.get(threadId) ?? createEmptyThreadRecord();
  return selector(rec);
}

/** Read active thread field in tests when currentThreadId is set. */
export function readActiveThreadField<T>(selector: (record: ThreadRecord) => T): T | undefined {
  const { currentThreadId, records } = useThreadStore.getState();
  if (!currentThreadId) return undefined;
  const rec = records.get(currentThreadId) ?? createEmptyThreadRecord();
  return selector(rec);
}

/** Active thread messages (replaces pre-migration `state.messages`). */
export function getTestActiveMessages(): Message[] {
  return readActiveThreadField((r) => r.messages) ?? [];
}

/** Per-thread field reads matching former `*ByThread` map access. */
export function getTestThreadMessages(threadId: string): Message[] {
  return readThreadField(threadId, (r) => r.messages);
}

export function getTestThreadStreaming(threadId: string): string | undefined {
  const v = readThreadField(threadId, (r) => r.streaming);
  return v || undefined;
}

export function getTestThreadStreamingPreview(threadId: string): string | undefined {
  const v = readThreadField(threadId, (r) => r.streamingPreview);
  return v || undefined;
}

export function getTestThreadToolCalls(threadId: string): ToolCall[] {
  return readExistingThreadField(threadId, (r) => r.toolCalls) ?? [];
}

export function getTestThreadThoughtSegments(threadId: string): ThoughtSegment[] | undefined {
  return readExistingThreadField(threadId, (r) => r.thoughtSegments);
}

export function getTestThreadError(threadId: string): string | undefined {
  return readExistingThreadField(threadId, (r) => r.error ?? undefined);
}

export function getTestThreadPermissions(threadId: string): StoredPermission[] {
  return readThreadField(threadId, (r) => r.permissions);
}

export function getTestThreadAgentStartTime(threadId: string): number | undefined {
  return readThreadField(threadId, (r) => r.agentStartTime);
}

/** All thread agent start times (replaces `state.agentStartTimes`). */
export function getTestAgentStartTimes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rec] of useThreadStore.getState().records) {
    if (rec.agentStartTime != null) out[id] = rec.agentStartTime;
  }
  return out;
}

export function getTestThreadAnsweredPlanIds(threadId: string): Set<string> | undefined {
  return readExistingThreadField(threadId, (r) => r.answeredPlanMessageIds);
}

export function getTestThreadPlanQuestions(threadId: string): PlanQuestion[] | null | undefined {
  return readExistingThreadField(threadId, (r) => r.planQuestions);
}

/**
 * Legacy flat seed shape used by tests before ThreadRecord migration.
 * Converts former top-level mirrors and `*ByThread` maps into `records`.
 */
export interface LegacyThreadStoreSeed {
  currentThreadId?: string | null;
  runningThreadIds?: Set<string>;
  recentlyAnsweredPlanMessageIds?: Set<string>;
  messages?: Message[];
  loading?: boolean;
  oldestLoadedSequence?: number | Record<string, number>;
  hasMoreMessages?: boolean | Record<string, boolean>;
  isLoadingMore?: boolean | Record<string, boolean>;
  loadEpoch?: number;
  persistedToolCallCounts?: Record<string, number>;
  persistedFilesChanged?: Record<string, string[]>;
  latestTurnWithChanges?: string | null;
  serverMessageIds?: Record<string, string>;
  narrativeByMessage?: ThreadRecord["narrativeByMessage"];
  loadEpochByThread?: Record<string, number>;
  errorByThread?: Record<string, string | null>;
  streamingByThread?: Record<string, string>;
  streamingPreviewByThread?: Record<string, string>;
  toolCallsByThread?: Record<string, ToolCall[]>;
  agentStartTimes?: Record<string, number>;
  currentTurnMessageIdByThread?: Record<string, string>;
  thoughtSegmentsByThread?: Record<string, ThoughtSegment[]>;
  hooksByThread?: Record<string, HookExecution[]>;
  isCompactingByThread?: Record<string, boolean>;
  settingsByThread?: Record<string, ThreadSettings>;
  contextByThread?: Record<string, ThreadRecord["context"]>;
  usageByProvider?: Record<string, ProviderUsageInfo>;
  lastFallbackByThread?: Record<string, ThreadRecord["lastFallback"]>;
  rateLimitByThread?: Record<string, ThreadRecord["rateLimit"]>;
  apiRetryByThread?: Record<string, ThreadRecord["apiRetry"]>;
  planQuestionsByThread?: Record<string, PlanQuestion[] | null>;
  planAnswersByThread?: Record<string, Map<string, PlanAnswer>>;
  activeQuestionIndexByThread?: Record<string, number>;
  planQuestionsStatusByThread?: Record<string, ThreadRecord["planQuestionsStatus"]>;
  permissionsByThread?: Record<string, StoredPermission[]>;
  handoffMeta?: Record<string, HandoffMeta>;
  forkMode?: Record<string, ThreadForkMode | null>;
  answeredPlanMessageIdsByThread?: Record<string, Set<string>>;
  lastHydratedByThread?: Record<string, number>;
  awaitingUserStopPersistByThread?: Record<string, true>;
  interruptStopFileNoticeByThread?: Record<string, ThreadRecord["interruptStopFileNotice"]>;
  composerRecallFromStopByThread?: Record<string, ThreadRecord["composerRecallFromStop"]>;
  records?: Map<string, ThreadRecord>;
  toolCallRecordCache?: ReturnType<typeof createEmptyThreadStoreState>["toolCallRecordCache"];
}

const BY_THREAD_FIELD_MAP: Array<{
  legacyKey: keyof LegacyThreadStoreSeed;
  recordKey: keyof ThreadRecord;
  isEmpty?: (value: unknown) => boolean;
}> = [
  { legacyKey: "errorByThread", recordKey: "error", isEmpty: (v) => v == null },
  { legacyKey: "streamingByThread", recordKey: "streaming", isEmpty: (v) => !v },
  { legacyKey: "streamingPreviewByThread", recordKey: "streamingPreview", isEmpty: (v) => !v },
  { legacyKey: "toolCallsByThread", recordKey: "toolCalls", isEmpty: (v) => !Array.isArray(v) || v.length === 0 },
  { legacyKey: "agentStartTimes", recordKey: "agentStartTime" },
  { legacyKey: "currentTurnMessageIdByThread", recordKey: "currentTurnMessageId", isEmpty: (v) => !v },
  { legacyKey: "thoughtSegmentsByThread", recordKey: "thoughtSegments", isEmpty: (v) => !Array.isArray(v) || v.length === 0 },
  { legacyKey: "hooksByThread", recordKey: "hooks", isEmpty: (v) => !Array.isArray(v) || v.length === 0 },
  { legacyKey: "isCompactingByThread", recordKey: "isCompacting", isEmpty: (v) => !v },
  { legacyKey: "settingsByThread", recordKey: "settings" },
  { legacyKey: "contextByThread", recordKey: "context", isEmpty: (v) => v == null },
  { legacyKey: "lastFallbackByThread", recordKey: "lastFallback", isEmpty: (v) => v == null },
  { legacyKey: "rateLimitByThread", recordKey: "rateLimit", isEmpty: (v) => v == null },
  { legacyKey: "apiRetryByThread", recordKey: "apiRetry", isEmpty: (v) => v == null },
  { legacyKey: "planQuestionsByThread", recordKey: "planQuestions", isEmpty: (v) => v == null },
  { legacyKey: "planAnswersByThread", recordKey: "planAnswers" },
  { legacyKey: "activeQuestionIndexByThread", recordKey: "activeQuestionIndex" },
  { legacyKey: "planQuestionsStatusByThread", recordKey: "planQuestionsStatus" },
  { legacyKey: "permissionsByThread", recordKey: "permissions", isEmpty: (v) => !Array.isArray(v) || v.length === 0 },
  { legacyKey: "handoffMeta", recordKey: "handoffMeta", isEmpty: (v) => v == null },
  { legacyKey: "forkMode", recordKey: "forkMode", isEmpty: (v) => v == null },
  { legacyKey: "answeredPlanMessageIdsByThread", recordKey: "answeredPlanMessageIds" },
  { legacyKey: "lastHydratedByThread", recordKey: "lastHydratedAt" },
  { legacyKey: "awaitingUserStopPersistByThread", recordKey: "awaitingUserStopPersist", isEmpty: (v) => !v },
  { legacyKey: "interruptStopFileNoticeByThread", recordKey: "interruptStopFileNotice", isEmpty: (v) => v == null },
  { legacyKey: "composerRecallFromStopByThread", recordKey: "composerRecallFromStop", isEmpty: (v) => v == null },
];

const LEGACY_THREAD_MAP_FIELDS: Array<{
  seedKey: keyof LegacyThreadStoreSeed;
  recordKey: keyof ThreadRecord;
  isEmpty?: (value: unknown) => boolean;
}> = [
  { seedKey: "loadEpochByThread", recordKey: "loadEpoch" },
];

function isRecordSeedValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Set) && !(value instanceof Map);
}

function collectLegacyThreadIds(seed: LegacyThreadStoreSeed): Set<string> {
  const ids = new Set<string>();
  for (const { legacyKey } of BY_THREAD_FIELD_MAP) {
    const map = seed[legacyKey] as Record<string, unknown> | undefined;
    if (map) Object.keys(map).forEach((id) => ids.add(id));
  }
  for (const { seedKey } of LEGACY_THREAD_MAP_FIELDS) {
    const map = seed[seedKey] as Record<string, unknown> | undefined;
    if (map) Object.keys(map).forEach((id) => ids.add(id));
  }
  for (const key of ["oldestLoadedSequence", "hasMoreMessages", "isLoadingMore"] as const) {
    const value = seed[key];
    if (isRecordSeedValue(value)) Object.keys(value).forEach((id) => ids.add(id));
  }
  if (seed.currentThreadId) ids.add(seed.currentThreadId);
  return ids;
}

/** Apply a legacy flat test seed to the thread store (maps → ThreadRecord). */
export function applyLegacyThreadStoreSeed(
  seed: LegacyThreadStoreSeed,
  opts?: { merge?: boolean },
): void {
  const prior = opts?.merge ? useThreadStore.getState() : null;
  let records = seed.records ?? (opts?.merge ? new Map(prior!.records) : new Map<string, ThreadRecord>());
  const threadIds = collectLegacyThreadIds(seed);

  for (const threadId of threadIds) {
    const patch: Partial<ThreadRecord> = {};
    for (const { legacyKey, recordKey, isEmpty } of BY_THREAD_FIELD_MAP) {
      const map = seed[legacyKey] as Record<string, unknown> | undefined;
      if (!map || !(threadId in map)) continue;
      const value = map[threadId];
      if (isEmpty?.(value)) continue;
      (patch as Record<string, unknown>)[recordKey as string] = value;
    }
    for (const { seedKey, recordKey, isEmpty } of LEGACY_THREAD_MAP_FIELDS) {
      const map = seed[seedKey] as Record<string, unknown> | undefined;
      if (!map || !(threadId in map)) continue;
      const value = map[threadId];
      if (isEmpty?.(value)) continue;
      (patch as Record<string, unknown>)[recordKey as string] = value;
    }
    for (const key of ["oldestLoadedSequence", "hasMoreMessages", "isLoadingMore"] as const) {
      const value = seed[key];
      if (!isRecordSeedValue(value) || !(threadId in value)) continue;
      const entry = value[threadId];
      if (entry == null && key !== "isLoadingMore") continue;
      (patch as Record<string, unknown>)[key] = entry;
    }
    if (Object.keys(patch).length > 0) {
      records = patchThreadRecord(records, threadId, patch);
    }
  }

  const activeId =
    seed.currentThreadId !== undefined
      ? seed.currentThreadId
      : (opts?.merge ? prior?.currentThreadId ?? null : null);
  if (activeId) {
    const activePatch: Partial<ThreadRecord> = {};
    if (seed.messages !== undefined) activePatch.messages = seed.messages;
    if (seed.loading !== undefined) activePatch.loading = seed.loading;
    if (seed.oldestLoadedSequence !== undefined && typeof seed.oldestLoadedSequence === "number") {
      activePatch.oldestLoadedSequence = seed.oldestLoadedSequence;
    }
    if (seed.hasMoreMessages !== undefined && typeof seed.hasMoreMessages === "boolean") {
      activePatch.hasMoreMessages = seed.hasMoreMessages;
    }
    if (seed.isLoadingMore !== undefined && typeof seed.isLoadingMore === "boolean") {
      activePatch.isLoadingMore = seed.isLoadingMore;
    }
    if (seed.loadEpoch !== undefined) activePatch.loadEpoch = seed.loadEpoch;
    if (seed.persistedToolCallCounts !== undefined) activePatch.persistedToolCallCounts = seed.persistedToolCallCounts;
    if (seed.persistedFilesChanged !== undefined) activePatch.persistedFilesChanged = seed.persistedFilesChanged;
    if (seed.latestTurnWithChanges !== undefined) activePatch.latestTurnWithChanges = seed.latestTurnWithChanges;
    if (seed.serverMessageIds !== undefined) activePatch.serverMessageIds = seed.serverMessageIds;
    if (seed.narrativeByMessage !== undefined) activePatch.narrativeByMessage = seed.narrativeByMessage;
    if (seed.usageByProvider !== undefined) activePatch.usageByProvider = seed.usageByProvider;
    if (Object.keys(activePatch).length > 0) {
      records = patchThreadRecord(records, activeId, activePatch);
    }
  }

  useThreadStore.setState({
    ...createEmptyThreadStoreState(),
    records,
    currentThreadId: activeId,
    runningThreadIds: seed.runningThreadIds ?? prior?.runningThreadIds ?? new Set(),
    recentlyAnsweredPlanMessageIds:
      seed.recentlyAnsweredPlanMessageIds ?? prior?.recentlyAnsweredPlanMessageIds ?? new Set(),
    ...(seed.toolCallRecordCache !== undefined
      ? { toolCallRecordCache: seed.toolCallRecordCache }
      : prior?.toolCallRecordCache
        ? { toolCallRecordCache: prior.toolCallRecordCache }
        : {}),
  });
}

/** Patch loadEpoch on one thread record (replaces `loadEpochByThread` setState). */
export function patchTestThreadLoadEpoch(threadId: string, loadEpoch: number): void {
  useThreadStore.setState((s) => ({
    records: patchThreadRecord(s.records, threadId, { loadEpoch }),
  }));
}

/** Read persistedFilesChanged from a thread record. */
export function getTestThreadPersistedFilesChanged(
  threadId: string,
): Record<string, string[]> {
  return readThreadField(threadId, (r) => r.persistedFilesChanged);
}

/** Read a scalar pagination field from a thread record. */
export function getTestThreadOldestLoadedSequence(threadId: string): number {
  return readThreadField(threadId, (r) => r.oldestLoadedSequence);
}

export function getTestThreadHasMoreMessages(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.hasMoreMessages);
}

export function getTestThreadIsLoadingMore(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.isLoadingMore);
}

export function getTestThreadLoadEpoch(threadId: string): number {
  return readThreadField(threadId, (r) => r.loadEpoch);
}

/** Whether a thread record still exists in the store Map. */
export function hasTestThreadRecord(threadId: string): boolean {
  return useThreadStore.getState().records.has(threadId);
}

export function getTestThreadContext(threadId: string): ThreadRecord["context"] {
  return readThreadField(threadId, (r) => r.context);
}

export function getTestThreadIsCompacting(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.isCompacting);
}

export function getTestThreadLastFallback(threadId: string): ThreadRecord["lastFallback"] {
  return readThreadField(threadId, (r) => r.lastFallback);
}

export function getTestThreadPlanQuestionsStatus(
  threadId: string,
): ThreadRecord["planQuestionsStatus"] | undefined {
  return readExistingThreadField(threadId, (r) => r.planQuestionsStatus);
}

export function getTestThreadSettings(threadId: string): ThreadSettings {
  return readThreadField(threadId, (r) => r.settings);
}

export function getTestThreadCurrentTurnMessageId(threadId: string): string {
  return readThreadField(threadId, (r) => r.currentTurnMessageId);
}

export function getTestActiveLoading(): boolean {
  return readActiveThreadField((r) => r.loading) ?? false;
}

export function getTestActiveLatestTurnWithChanges(): string | null {
  return readActiveThreadField((r) => r.latestTurnWithChanges) ?? null;
}
