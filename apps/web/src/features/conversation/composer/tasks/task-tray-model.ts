import type { TaskItem, TaskProgress } from "@/stores/taskStore";

/** The task tray's lifecycle; `closing` keeps the tray mounted until its fold animation finishes. */
export type TaskTrayPhase = "closed" | "open" | "closing";

/** Inputs to the tray lifecycle: `folded` reports the fold animation finished, and `cover` closes at once. */
export type TaskTrayEvent =
  | { readonly type: "toggle" }
  | { readonly type: "dismiss"; readonly animate: boolean }
  | { readonly type: "folded" }
  | { readonly type: "cover" };

/**
 * Next tray phase. Total and idempotent: any pair not listed keeps the phase,
 * so a late `folded` after a `cover` stays closed.
 */
export function nextTaskTrayPhase(phase: TaskTrayPhase, event: TaskTrayEvent): TaskTrayPhase {
  if (event.type === "cover") return "closed";
  if (phase === "closed" && event.type === "toggle") return "open";
  if (phase === "open" && event.type === "dismiss") return event.animate ? "closing" : "closed";
  if (phase === "closing" && event.type === "folded") return "closed";
  return phase;
}

function isSettled(task: TaskItem): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

/** The tray's always-listed rows, and the settled tasks it lists under a Done toggle after them. */
export interface TaskTrayRows {
  readonly rows: readonly TaskItem[];
  readonly done: readonly TaskItem[];
}

/**
 * While work remains, settled tasks move below the open ones, under a Done
 * toggle. Once every task is settled there is nothing left to separate, so
 * every task is listed and `done` is empty.
 */
export function taskTrayRows(tasks: readonly TaskItem[]): TaskTrayRows {
  const done = tasks.filter(isSettled);
  if (done.length === tasks.length) return { rows: tasks, done: [] };
  return { rows: tasks.filter((task) => !isSettled(task)), done };
}

/** Accessible name of the tab and the tray header, e.g. "Tasks, 2 of 9 done". */
export function taskProgressLabel(progress: TaskProgress): string {
  return `${progress.title}, ${progress.settled} of ${progress.total} done`;
}
