import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
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

interface TaskDoneToggleProps {
  readonly count: number;
  readonly open: boolean;
  readonly toggleRef: RefObject<HTMLLIElement | null>;
  readonly onToggle: () => void;
}

/** Matches the sidebar's Older toggle: label, count, and a chevron that turns down when open. */
function TaskDoneToggle({ count, open, toggleRef, onToggle }: TaskDoneToggleProps) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li ref={toggleRef} role="none">
      <button
        type="button"
        aria-label={`${count} done`}
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-[32px] w-full items-center gap-[8px] px-[8px] text-caption text-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/70"
      >
        <span className="min-w-0 flex-1 text-left">Done</span>
        <span className="tabular-nums">{count}</span>
        <Chevron className="size-[14px] shrink-0" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Opening the Done toggle scrolls it to the list's top, so the rows it reveals
 * below it come into view. The list's scroll padding matches its top fade, so
 * the toggle stops below the fade instead of under it.
 */
function useRevealDone(open: boolean) {
  const listRef = useRef<HTMLUListElement>(null);
  const toggleRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const toggle = toggleRef.current;
    if (!open || !list || !toggle) return;
    const fade = Number.parseFloat(getComputedStyle(list).scrollPaddingTop) || 0;
    list.scrollTop = toggle.offsetTop - fade;
  }, [open]);
  return { listRef, toggleRef };
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
 * segment bar, and the task list with settled tasks under a Done toggle at its end.
 */
export function TaskTray({ id, progress, tasks, trayRef, headerRef, bodyRef, onClose }: TaskTrayProps) {
  const [showDone, setShowDone] = useState(false);
  const { rows, done } = taskTrayRows(tasks);
  const { listRef, toggleRef } = useRevealDone(showDone);
  return (
    <div
      ref={trayRef}
      id={id}
      role="region"
      aria-label={progress.title}
      className={cn(
        "tab-fillets absolute right-[24px] bottom-[calc(100%-1px)] left-[24px] flex flex-col",
        "rounded-t-[14px] border border-b-0 border-border bg-selected px-[6px] pt-[4px] pb-[6px]",
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
        {/* Focusable so keyboard users can scroll a list taller than five rows. */}
        <ul
          ref={listRef}
          aria-label="Tasks"
          tabIndex={0}
          className="scroll-fade-y relative m-0 max-h-[164px] list-none overflow-y-auto rounded-control p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus/50 motion-safe:scroll-smooth"
        >
          {rows.map((task) => (
            <TaskListRow key={task.id} task={task} />
          ))}
          {done.length > 0 && (
            <TaskDoneToggle count={done.length} open={showDone} toggleRef={toggleRef} onToggle={() => setShowDone(!showDone)} />
          )}
          {showDone && done.map((task) => <TaskListRow key={task.id} task={task} />)}
        </ul>
      </div>
    </div>
  );
}
