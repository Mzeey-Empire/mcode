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

/** Tray rows, and the settled count folded into one row, or null when nothing folds. */
export interface TaskTrayRows {
  readonly folded: number | null;
  readonly rows: readonly TaskItem[];
}

/**
 * Settled tasks fold into one count while work remains. Nothing folds when no
 * task or every task is settled. `showDone` lists every task.
 */
export function taskTrayRows(tasks: readonly TaskItem[], showDone: boolean): TaskTrayRows {
  const settled = tasks.filter(isSettled).length;
  const folded = settled > 0 && settled < tasks.length ? settled : null;
  const rows = folded !== null && !showDone ? tasks.filter((task) => !isSettled(task)) : tasks;
  return { folded, rows };
}

/** Accessible name of the tab and the tray header, e.g. "Tasks, 2 of 9 done". */
export function taskProgressLabel(progress: TaskProgress): string {
  return `${progress.title}, ${progress.settled} of ${progress.total} done`;
}
