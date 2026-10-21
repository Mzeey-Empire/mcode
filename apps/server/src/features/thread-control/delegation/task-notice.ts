import type { DelegatedTaskNotice, SystemNoticeMetadata, TaskState } from "@mcode/contracts";

/** One notifiable task snapshot and its durable coverage key. */
export interface TaskNoticeEntry {
  key: string;
  task: DelegatedTaskNotice;
  detail: string;
}

/** A claimed batch uses the same message identity on the send and steer paths. */
export interface TaskNoticeBatch {
  wakeId: string;
  content: string;
  systemNotice: SystemNoticeMetadata;
}

/** Derive a stable notice identity, suppressing interrupted attempts scheduled to resume. */
export function taskNoticeKey(taskId: string, state: TaskState, attemptId: string | null,
  requestIds: readonly string[], resumeScheduled = false): string | null {
  if (state.status === "finished") {
    if (state.outcome === "interrupted" && resumeScheduled) return null;
    return attemptId ? `finished:${state.outcome}:${attemptId}` : `failed:startup:${taskId}`;
  }
  if (state.status !== "waiting" || state.reason === "approval") return null;
  if (state.reason === "setup_blocked") return `setup_blocked:${taskId}`;
  return `needs_input:${JSON.stringify([...new Set(requestIds)].sort())}`;
}

/** Answered questions remain covered; only a newly pending request needs another notice. */
export function noticeCovered(delivered: string | null, current: string): boolean {
  if (delivered === current) return true;
  const prefix = "needs_input:";
  if (!delivered?.startsWith(prefix) || !current.startsWith(prefix)) return false;
  const seen: unknown = JSON.parse(delivered.slice(prefix.length));
  const pending: unknown = JSON.parse(current.slice(prefix.length));
  return Array.isArray(seen) && Array.isArray(pending) && pending.every((id: unknown) => seen.includes(id));
}

/** Render bounded provider text and matching timeline attribution for a claimed batch. */
export function renderTaskNotices(wakeId: string, entries: readonly TaskNoticeEntry[]): TaskNoticeBatch {
  const sections = entries.map(({ task, detail }) => {
    const header = `${task.title} | child ${task.threadId ?? "not started"} | ${task.status}`;
    const instruction = task.status === "needs_input"
      ? "\nThe user answers this in the composer. Do not answer it yourself." : "";
    return `${header}\n${detail.slice(0, 4_000)}${instruction}`;
  });
  const footer = "\n\nUse task_status for detail.";
  return {
    wakeId, content: sections.join("\n\n").slice(0, 16_000 - footer.length) + footer,
    systemNotice: { kind: "delegated-task", presentation: "timeline", delegatedTasks: entries.map((entry) => entry.task) },
  };
}
