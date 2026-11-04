import { useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskItem, TaskProgress, TaskSegment, TaskStatus } from "@/stores/taskStore";
import { taskProgressLabel, taskTrayRows } from "./task-tray-model";

interface TaskStatusView {
  readonly label: string;
  readonly mark: ReactNode;
  readonly textClass: string;
}

const TASK_STATUS_VIEW: Record<TaskStatus, TaskStatusView> = {
  completed: {
    label: "Completed",
    mark: <Check className="size-[14px] text-muted" aria-hidden />,
    textClass: "text-muted",
  },
  in_progress: {
    label: "In progress",
    mark: <span className="size-[6px] rounded-full bg-ink" aria-hidden />,
    textClass: "text-ink",
  },
  pending: {
    label: "Pending",
    // The tray fills with `selected`, which equals `border` in light theme.
    mark: <span className="size-[6px] rounded-full border-[1.5px] border-muted" aria-hidden />,
    textClass: "text-muted",
  },
  cancelled: {
    label: "Cancelled",
    mark: <X className="size-[14px] text-muted" aria-hidden />,
    textClass: "text-muted line-through",
  },
};

const BAR_SEGMENT_CLASS: Record<TaskSegment, string> = {
  done: "bg-ink",
  current: "bg-muted",
  // `bg-border` would vanish against the light-theme tray fill.
  pending: "bg-ink/12",
};

function TaskListRow({ task }: { task: TaskItem }) {
  const view = TASK_STATUS_VIEW[task.status];
  const active = task.status === "in_progress";
  return (
    <li className={cn("flex h-[32px] items-center gap-[8px] px-[8px]", active && "rounded-full bg-ink/7")}>
      <span className="flex size-[14px] shrink-0 items-center justify-center">{view.mark}</span>
      <span className={cn("text-fade flex-1 text-compact", view.textClass)}>
        <span className="sr-only">{view.label}: </span>
        {active ? task.activeForm ?? task.content : task.content}
      </span>
    </li>
  );
}

function TaskTrayBar({ segments }: { segments: readonly TaskSegment[] }) {
  return (
    <div className="mx-[8px] mt-[4px] mb-[6px] flex h-[3px] gap-[2px]" aria-hidden>
      {segments.map((segment, index) => (
        <span key={index} className={cn("min-w-px flex-1 rounded-full", BAR_SEGMENT_CLASS[segment])} />
      ))}
    </div>
  );
}

function TaskFoldRow({ count, showDone, onToggle }: { count: number; showDone: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={showDone}
      onClick={onToggle}
      className="flex h-[32px] w-full items-center gap-[8px] rounded-full px-[8px] text-compact text-muted hover:bg-hover hover:text-ink"
    >
      <Check className="size-[14px] shrink-0" aria-hidden />
      <span className="flex-1 text-left">{count} done</span>
      <ChevronDown className={cn("size-[14px] shrink-0", showDone && "rotate-180")} aria-hidden />
    </button>
  );
}

/** Props for {@link TaskTray}. */
export interface TaskTrayProps {
  readonly id: string;
  readonly progress: TaskProgress;
  readonly tasks: readonly TaskItem[];
  readonly trayRef: RefObject<HTMLDivElement | null>;
  readonly headerRef: RefObject<HTMLButtonElement | null>;
  readonly bodyRef: RefObject<HTMLDivElement | null>;
  readonly onClose: () => void;
}

/**
 * The tray that grows out of the task tab: a header that closes it, the
 * segment bar, the settled tasks folded into one row, and the task list.
 */
export function TaskTray({ id, progress, tasks, trayRef, headerRef, bodyRef, onClose }: TaskTrayProps) {
  const [showDone, setShowDone] = useState(false);
  const { folded, rows } = taskTrayRows(tasks, showDone);
  return (
    <div
      ref={trayRef}
      id={id}
      role="region"
      aria-label={progress.title}
      className={cn(
        "tab-fillets absolute right-[24px] bottom-[calc(100%-1px)] left-[24px] flex flex-col",
        "rounded-t-[14px] border border-b-0 border-border bg-selected px-[6px] pt-[4px] pb-[6px]",
        "group-focus-within/capsule:border-control-border group-focus-within/capsule:[--tab-edge:var(--color-control-border)]",
      )}
    >
      <button
        ref={headerRef}
        type="button"
        aria-label={taskProgressLabel(progress)}
        aria-expanded="true"
        onClick={onClose}
        className="flex h-[28px] w-full items-center gap-[8px] rounded-full px-[8px] hover:bg-hover"
      >
        <span className="shrink-0 text-caption text-ink tabular-nums">
          {progress.settled}/{progress.total}
        </span>
        <span className="text-fade flex-1 text-left text-compact text-ink">{progress.title}</span>
        <ChevronDown className="size-[14px] shrink-0 text-muted" aria-hidden />
      </button>
      <div ref={bodyRef}>
        <TaskTrayBar segments={progress.segments} />
        {folded !== null && (
          <TaskFoldRow count={folded} showDone={showDone} onToggle={() => setShowDone(!showDone)} />
        )}
        {/* Focusable so keyboard users can scroll a list taller than five rows. */}
        <ul
          aria-label="Tasks"
          tabIndex={0}
          className="scroll-fade-y m-0 max-h-[164px] list-none overflow-y-auto rounded-control p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          {rows.map((task) => (
            <TaskListRow key={task.id} task={task} />
          ))}
        </ul>
      </div>
    </div>
  );
}
