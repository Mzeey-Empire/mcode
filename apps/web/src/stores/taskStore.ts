import { useMemo } from "react";
import type { PlanVersion } from "@mcode/contracts";
import { create } from "zustand";
import { usePlanStore } from "./planStore";

/** Status of an individual task item. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Valid task status values for runtime validation. */
const VALID_TASK_STATUSES = new Set<string>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * Coerce an unknown status string to a valid TaskStatus, defaulting to "pending".
 * Accepts the American "canceled" spelling and normalizes it to "cancelled".
 */
export function coerceTaskStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? "");
  if (s === "inProgress" || s === "in-progress") return "in_progress";
  if (s === "canceled") return "cancelled";
  return VALID_TASK_STATUSES.has(s) ? (s as TaskStatus) : "pending";
}

/** A single task item within a group. */
export interface TaskItem {
  readonly id: string;
  /**
   * Harness-assigned task id from the Task* tool family (e.g. "1"), captured
   * from the TaskCreate result. Used to correlate later TaskUpdate calls to the
   * task they mutate. Absent for legacy TodoWrite/update_plan tasks.
   */
  readonly harnessTaskId?: string;
  /** Imperative form shown when not active (e.g. "Run tests"). */
  readonly content: string;
  /** Present continuous form shown when active (e.g. "Running tests"). Falls back to content if not provided. */
  readonly activeForm?: string;
  readonly status: TaskStatus;
  readonly group: string;
}

/** The parent-agent task list shown in the composer tray, with the turn that last wrote it. */
export interface TaskBubble {
  readonly tasks: readonly TaskItem[];
  /** Id of the user message of the turn that last wrote the parent "Tasks" list. */
  readonly sourceMessageId: string | null;
}

/** Zustand state shape for the task store. */
interface TaskState {
  /** Task items keyed by thread ID. */
  tasksByThread: Record<string, readonly TaskItem[]>;
  /** Parent-agent task list shown in the composer tray, keyed by thread ID. */
  taskBubbleByThread: Record<string, TaskBubble>;
  /** Threads keeping unsettled prior tasks until the next turn reports parent tasks. */
  pendingTaskBubbleReplacementByThread: Record<string, boolean>;
  /** Replace all tasks for a thread (top-level TodoWrite). */
  setTasks: (threadId: string, tasks: readonly TaskItem[], sourceMessageId?: string | null) => void;
  /** Replace only tasks belonging to a specific group, preserving other groups. */
  setGroupTasks: (
    threadId: string,
    group: string,
    tasks: readonly TaskItem[],
    sourceMessageId?: string | null,
  ) => void;
  /** Clear tasks for a thread (e.g. on deletion). */
  clearTasks: (threadId: string) => void;
  /** Apply new-turn lifecycle rules to the composer task list. */
  prepareTaskBubbleForNewTurn: (threadId: string) => void;
  /** Clear kept unsettled tasks when a new turn ends without parent-task updates. */
  clearTaskBubbleIfAwaitingReplacement: (threadId: string) => void;
}

const PARENT_TASK_GROUP = "Tasks";

function parentTasks(tasks: readonly TaskItem[]): readonly TaskItem[] {
  return tasks.filter((task) => task.group === PARENT_TASK_GROUP);
}

function isSettled(task: TaskItem): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

function allTasksSettled(tasks: readonly TaskItem[]): boolean {
  return tasks.length > 0 && tasks.every(isSettled);
}

/** Zustand store for per-thread task data. */
export const useTaskStore = create<TaskState>((set) => ({
  tasksByThread: {},
  taskBubbleByThread: {},
  pendingTaskBubbleReplacementByThread: {},
  setTasks: (threadId, tasks, sourceMessageId) =>
    set((s) => {
      const bubble: TaskBubble = { tasks: parentTasks(tasks), sourceMessageId: sourceMessageId ?? null };
      const pending = { ...s.pendingTaskBubbleReplacementByThread };
      delete pending[threadId];
      return {
        tasksByThread: { ...s.tasksByThread, [threadId]: tasks },
        taskBubbleByThread: { ...s.taskBubbleByThread, [threadId]: bubble },
        pendingTaskBubbleReplacementByThread: pending,
      };
    }),
  setGroupTasks: (threadId, group, tasks, sourceMessageId) =>
    set((s) => {
      const existing = s.tasksByThread[threadId] ?? [];
      const otherGroups = existing.filter((t) => t.group !== group);
      const pending = { ...s.pendingTaskBubbleReplacementByThread };
      const isParent = group === PARENT_TASK_GROUP;
      if (isParent) delete pending[threadId];
      return {
        tasksByThread: { ...s.tasksByThread, [threadId]: [...otherGroups, ...tasks] },
        ...(isParent
          ? {
              taskBubbleByThread: {
                ...s.taskBubbleByThread,
                [threadId]: { tasks, sourceMessageId: sourceMessageId ?? null },
              },
            }
          : {}),
        pendingTaskBubbleReplacementByThread: pending,
      };
    }),
  clearTasks: (threadId) =>
    set((s) => {
      const next = { ...s.tasksByThread };
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      delete next[threadId];
      delete nextBubble[threadId];
      delete nextPending[threadId];
      return {
        tasksByThread: next,
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
  prepareTaskBubbleForNewTurn: (threadId) =>
    set((s) => {
      const visible = s.taskBubbleByThread[threadId]
        ?? { tasks: parentTasks(s.tasksByThread[threadId] ?? []), sourceMessageId: null };
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      if (visible.tasks.length === 0 || allTasksSettled(visible.tasks)) {
        delete nextBubble[threadId];
        delete nextPending[threadId];
      } else {
        nextBubble[threadId] = visible;
        nextPending[threadId] = true;
      }
      return {
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
  clearTaskBubbleIfAwaitingReplacement: (threadId) =>
    set((s) => {
      if (!s.pendingTaskBubbleReplacementByThread[threadId]) return {};
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      delete nextBubble[threadId];
      delete nextPending[threadId];
      return {
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
}));

/** One task's place in the progress lane: settled, in progress, or not started. */
export type TaskSegment = "done" | "current" | "pending";

/** Collapsed summary of a thread's parent-agent task list. */
export interface TaskProgress {
  /** The implemented plan version's title, else "Tasks"; never the thread title. */
  readonly title: string;
  /** Completed plus cancelled tasks. */
  readonly settled: number;
  readonly total: number;
  readonly segments: readonly TaskSegment[];
}

const DEFAULT_TASK_LIST_TITLE = "Tasks";

function taskSegment(task: TaskItem): TaskSegment {
  if (isSettled(task)) return "done";
  return task.status === "in_progress" ? "current" : "pending";
}

function taskListTitle(
  sourceMessageId: string | null,
  plans: readonly PlanVersion[] | undefined,
): string {
  if (sourceMessageId === null) return DEFAULT_TASK_LIST_TITLE;
  const implemented = plans?.find((plan) => plan.acceptedMessageId === sourceMessageId);
  return implemented?.title ?? DEFAULT_TASK_LIST_TITLE;
}

/**
 * Summarize a task list for the composer tray and overview task rows.
 * Returns null when there is nothing to show.
 */
export function selectTaskProgress(
  bubble: TaskBubble | undefined,
  plans: readonly PlanVersion[] | undefined,
): TaskProgress | null {
  if (!bubble || bubble.tasks.length === 0) return null;
  const segments = bubble.tasks.map(taskSegment);
  return {
    title: taskListTitle(bubble.sourceMessageId, plans),
    settled: segments.filter((segment) => segment === "done").length,
    total: segments.length,
    segments,
  };
}

/**
 * Subscribe to a thread's task progress. Both selectors return stored
 * references, so unrelated task and plan writes do not change the result.
 */
export function useTaskProgress(threadId: string | undefined): TaskProgress | null {
  const bubble = useTaskStore((s) => (threadId ? s.taskBubbleByThread[threadId] : undefined));
  const plans = usePlanStore((s) => (threadId ? s.plansByThread[threadId] : undefined));
  return useMemo(() => selectTaskProgress(bubble, plans), [bubble, plans]);
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__taskStore = {
    get state() { return useTaskStore.getState(); },
    setTasks: (threadId: string, tasks: readonly TaskItem[], sourceMessageId?: string | null) =>
      useTaskStore.getState().setTasks(threadId, tasks, sourceMessageId),
    setGroupTasks: (
      threadId: string,
      group: string,
      tasks: readonly TaskItem[],
      sourceMessageId?: string | null,
    ) => useTaskStore.getState().setGroupTasks(threadId, group, tasks, sourceMessageId),
    clear: (threadId: string) => useTaskStore.getState().clearTasks(threadId),
  };
}
