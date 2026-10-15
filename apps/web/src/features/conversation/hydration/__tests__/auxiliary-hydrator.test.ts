import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PendingPlanImplement, PlanComment, PlanQuestion, PlanSnapshot, PlanVersion } from "@mcode/contracts";
import { HYDRATION_TTL_MS } from "..";
import { AuxiliaryHydrator } from "../auxiliary-hydrator";
import {
  cacheRecord as cacheConversationRecord,
  clearRecordCache,
  getCachedRecord,
  projectConversationCacheState,
} from "../record-cache";
import {
  createEmptyThreadRecord,
  getThreadRecord,
  patchThreadRecord,
  type ThreadRecord,
} from "@/stores/thread-record";
import type { ThreadHydratorWriteState } from "../types";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { coerceTaskStatus, type TaskItem } from "@/stores/taskStore";

const THREAD_ID = "aux-thread";

function makeThinRecord(): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
    messages: [createMockMessage({ id: "m1", thread_id: THREAD_ID, sequence: 1 })],
    oldestLoadedSequence: 1,
  };
}

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

const EMPTY_SNAPSHOT: PlanSnapshot = { versions: [], comments: [], phase: null, pendingQuestions: null, pendingImplement: null };

describe("AuxiliaryHydrator", () => {
  let setStateSpy: ReturnType<typeof vi.fn>;
  let setTasksForThread: (threadId: string, tasks: readonly unknown[]) => void;
  let addPlanForThread: (threadId: string, plan: PlanVersion) => void;
  let reconcilePlanQuestions: (
    threadId: string,
    revision: number,
    pending: { assistantMessageId: string; questions: PlanQuestion[] } | null,
  ) => void;
  let planQuestionsRevision: number;
  let setPlanCommentsForThread: (threadId: string, comments: readonly PlanComment[]) => void;
  let setPendingImplementForThread: (threadId: string, pending: PendingPlanImplement | null) => void;
  let records: Map<string, ThreadRecord>;
  let currentThreadId: string | null;

  beforeEach(() => {
    clearRecordCache();
    vi.clearAllMocks();
    records = new Map<string, ThreadRecord>();
    currentThreadId = THREAD_ID;

    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockTransport.getPlanSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(EMPTY_SNAPSHOT);
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    setStateSpy = vi.fn();
    setTasksForThread = vi.fn() as (threadId: string, tasks: readonly unknown[]) => void;
    addPlanForThread = vi.fn() as (threadId: string, plan: PlanVersion) => void;
    reconcilePlanQuestions = vi.fn() as typeof reconcilePlanQuestions;
    planQuestionsRevision = 0;
    setPlanCommentsForThread = vi.fn() as (threadId: string, comments: readonly PlanComment[]) => void;
    setPendingImplementForThread = vi.fn() as (threadId: string, pending: PendingPlanImplement | null) => void;

    cacheRecord(THREAD_ID, makeThinRecord());
  });

  function applySetState(
    partial:
      | Partial<ThreadHydratorWriteState>
      | ((state: ThreadHydratorWriteState) => Partial<ThreadHydratorWriteState>),
  ): void {
    (setStateSpy as (arg: unknown) => void)(partial);
    const base: ThreadHydratorWriteState = {
      records,
      currentThreadId,
      runningThreadIds: new Set<string>(),
    };
    const patch = typeof partial === "function" ? partial(base) : partial;
    if (patch.records) records = patch.records;
    if (patch.currentThreadId !== undefined) currentThreadId = patch.currentThreadId;
  }

  function createAux(
    overrides?: Partial<{
      getWorkspaceThread: () => { id: string; has_file_changes?: boolean } | undefined;
      getTasksForThread: (threadId: string) => readonly TaskItem[];
      runningThreadIds: Set<string>;
    }>,
  ): AuxiliaryHydrator {
    return new AuxiliaryHydrator({
      getTransport: () => mockTransport,
      getState: () => ({
        records,
        currentThreadId,
        runningThreadIds: overrides?.runningThreadIds ?? new Set(),
        toolCallRecordCache: { clear: vi.fn() },
      }),
      setState: applySetState,
      getWorkspaceThread:
        overrides?.getWorkspaceThread ??
        (() => createMockThread({ id: THREAD_ID, has_file_changes: false })),
      getTasksForThread: overrides?.getTasksForThread ?? (() => []),
      setTasksForThread,
      addPlanForThread,
      reconcilePlanQuestions,
      getPlanQuestionsRevision: () => planQuestionsRevision,
      setPlanCommentsForThread,
      setPendingImplementForThread,
      shallowEqualBy,
      coerceTaskStatus,
    });
  }

  it("skipped a second fanout within the freshness TTL window", async () => {
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: false });
    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: false });

    expect(mockTransport.getThreadTasks).not.toHaveBeenCalled();
  });

  it("ran fanout again when force bypassed the TTL gate", async () => {
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS });
    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });
    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledTimes(1);
    });
  });

  it("continued other fanouts when one RPC failed", async () => {
    const plan: PlanVersion = {
      id: "plan-1",
      threadId: THREAD_ID,
      messageId: "message-1",
      version: 1,
      title: "Plan 1",
      contentMd: "## Plan",
      author: "agent",
      providerId: "codex",
      captureSource: "fence",
      baseVersionId: null,
      revision: 0,
      acceptedAt: null,
      acceptedMessageId: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
      status: "ready",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("tasks down"),
    );
    (mockTransport.getPlanSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ ...EMPTY_SNAPSHOT, versions: [plan] });
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(addPlanForThread).toHaveBeenCalledWith(THREAD_ID, plan);
    });
  });

  it("handed the stored batch to the store with the revision read before the request", async () => {
    const questions: PlanQuestion[] = [
      { id: "q1", category: "AUTH", question: "Which provider?", options: [{ id: "a", title: "A", description: "" }, { id: "b", title: "B", description: "" }] },
    ];
    (mockTransport.getPlanSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...EMPTY_SNAPSHOT,
      phase: "questions",
      pendingQuestions: { assistantMessageId: "a1", questions },
    });
    planQuestionsRevision = 4;
    createAux().hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });
    planQuestionsRevision = 5;

    await vi.waitFor(() => {
      expect(reconcilePlanQuestions).toHaveBeenCalledWith(THREAD_ID, 4, { assistantMessageId: "a1", questions });
    });
  });

  it("restored the Implement the server holds behind Setup", async () => {
    const pending = { targetThreadId: "target-thread", version: 2 };
    (mockTransport.getPlanSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ ...EMPTY_SNAPSHOT, pendingImplement: pending });
    createAux().hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setPendingImplementForThread).toHaveBeenCalledWith(THREAD_ID, pending);
    });
  });

  it("told the store when the snapshot has no pending batch", async () => {
    createAux().hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(reconcilePlanQuestions).toHaveBeenCalledWith(THREAD_ID, 0, null);
    });
  });

  it("kept live tasks for a running thread when task hydration returned no persisted tasks", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Buy groceries - Pick up milk, eggs, bread",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    await vi.mocked(mockTransport.getThreadTasks).mock.results[0]?.value;

    expect(setTasksForThread).not.toHaveBeenCalled();
  });

  it("kept live tasks for a running thread group when hydration returned stale persisted tasks", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Clean the kitchen - Dishes, counters, floor",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "Buy groceries - Pick up milk, eggs, bread",
        status: "pending",
        group: "Tasks",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    await vi.mocked(mockTransport.getThreadTasks).mock.results[0]?.value;

    expect(setTasksForThread).not.toHaveBeenCalled();
  });

  it("merged persisted groups that were missing from live tasks on a running thread", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Clean the kitchen - Dishes, counters, floor",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "Check child diagnostics",
        status: "pending",
        group: "Sub-agent",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "0",
          content: "Check child diagnostics",
          status: "pending",
          group: "Sub-agent",
        },
        liveTask,
      ]);
    });
  });

  it("replaced stale in-memory tasks with persisted tasks when the thread was idle", async () => {
    const staleTask: TaskItem = {
      id: "task-stale",
      content: "Old task",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "New task",
        status: "completed",
        group: "Tasks",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [staleTask],
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "0",
          content: "New task",
          status: "completed",
          group: "Tasks",
        },
      ]);
    });
  });

  it("carried the harness task id and activeForm from persisted Task* tasks", async () => {
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "1",
        content: "Run tests",
        status: "in_progress",
        activeForm: "Running tests",
        group: "Tasks",
      },
    ]);

    const aux = createAux({ getTasksForThread: () => [] });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "1",
          harnessTaskId: "1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
          group: "Tasks",
        },
      ]);
    });
  });

  it("committed persisted tasks that differ only in identity fields so harnessTaskId reaches the store", async () => {
    // The live task matches on content/status/group but lacks the harness id, so
    // a gate that ignored identity fields would skip the write and later
    // TaskUpdate correlation by harnessTaskId would never land.
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Run tests",
      status: "in_progress",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "1",
        content: "Run tests",
        status: "in_progress",
        group: "Tasks",
      },
    ]);

    const aux = createAux({ getTasksForThread: () => [liveTask] });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "1",
          harnessTaskId: "1",
          content: "Run tests",
          status: "in_progress",
          group: "Tasks",
        },
      ]);
    });
  });

  it("backfilled file-change snapshots for thin cache entries on threads with changes", async () => {
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        message_id: "turn-1",
        files_changed: ["src/a.ts"],
        thread_id: THREAD_ID,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const aux = createAux({
      getWorkspaceThread: () => createMockThread({ id: THREAD_ID, has_file_changes: true }),
    });
    aux.hydrate(THREAD_ID, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: true,
      commitFileChangesToStore: true,
    });

    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
    });

    expect(getCachedRecord(THREAD_ID)?.latestTurnWithChanges).toBe("turn-1");
    expect(getCachedRecord(THREAD_ID)?.persistedFilesChanged).toEqual({
      "turn-1": ["src/a.ts"],
    });
  });

  it("preserves live file facts while backfilling historical snapshots", async () => {
    const liveSummary = {
      revision: 3,
      fileCount: 1,
      additions: 2,
      deletions: 0,
      effects: [],
    };
    const liveRecord = {
      ...makeThinRecord(),
      fileEffectTurnId: "live-turn",
      fileEffectSummary: liveSummary,
    };
    records = new Map([[THREAD_ID, liveRecord]]);
    cacheRecord(THREAD_ID, liveRecord);
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        message_id: "persisted-turn",
        files_changed: ["src/old.ts"],
        file_effects: {
          revision: 8,
          fileCount: 8,
          additions: 8,
          deletions: 8,
          effects: [],
        },
      },
    ]);

    const aux = createAux({
      getWorkspaceThread: () => createMockThread({ id: THREAD_ID, has_file_changes: true }),
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: true,
      commitFileChangesToStore: true,
    });

    await vi.waitFor(() => {
      expect(getThreadRecord(records, THREAD_ID).persistedFilesChanged).toEqual({
        "persisted-turn": ["src/old.ts"],
      });
    });
    expect(getThreadRecord(records, THREAD_ID).fileEffectSummary).toEqual(liveSummary);
    expect(getCachedRecord(THREAD_ID)?.settledFileEffectSummary).toBeNull();
  });

  it("discarded file-change snapshots after the expected load epoch changed", async () => {
    let resolveSnapshots!: (value: Array<{
      message_id: string;
      files_changed: string[];
      thread_id: string;
      created_at: string;
    }>) => void;
    records = patchThreadRecord(records, THREAD_ID, { loadEpoch: 4 });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshots = resolve;
      }),
    );

    const aux = createAux({
      getWorkspaceThread: () => createMockThread({ id: THREAD_ID, has_file_changes: true }),
    });
    aux.hydrate(THREAD_ID, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: true,
      commitFileChangesToStore: true,
      expectedLoadEpoch: 4,
    });
    records = patchThreadRecord(records, THREAD_ID, { loadEpoch: 5 });

    resolveSnapshots([{
      message_id: "turn-stale",
      files_changed: ["src/stale.ts"],
      thread_id: THREAD_ID,
      created_at: "2026-01-01T00:00:00Z",
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getCachedRecord(THREAD_ID)?.persistedFilesChanged).toEqual({});
    expect(getThreadRecord(records, THREAD_ID).persistedFilesChanged).toEqual({});
  });
});
