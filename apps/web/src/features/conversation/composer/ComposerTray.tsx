import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronUp, ListChecks, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQueueStore } from "@/stores/queueStore";
import {
  useTaskStore,
  type TaskItem,
  type TaskProgress,
  type TaskSegment,
  type TaskStatus,
} from "@/stores/taskStore";
import { UsageLimitRow, useUsageLimitTray } from "./UsageLimitRow";
import { CurrentStepTray, useTasksVariant, useTrayTaskProgress } from "./tasks-prototype/TasksPrototype.prototype";

const SEGMENT_CLASS: Record<TaskSegment, string> = {
  done: "bg-ink",
  current: "bg-muted",
  pending: "bg-border",
};

interface TaskStatusView {
  readonly label: string;
  readonly mark: ReactNode;
  readonly textClass: string;
}

const TASK_STATUS_VIEW: Record<TaskStatus, TaskStatusView> = {
  completed: {
    label: "Completed",
    mark: <Check className="size-3.5 text-muted" aria-hidden />,
    textClass: "text-muted",
  },
  in_progress: {
    label: "In progress",
    mark: <span className="size-1.5 rounded-full bg-ink" aria-hidden />,
    textClass: "text-ink",
  },
  pending: {
    label: "Pending",
    mark: <span className="size-1.5 rounded-full border border-muted" aria-hidden />,
    textClass: "text-muted",
  },
  cancelled: {
    label: "Cancelled",
    mark: <X className="size-3.5 text-muted" aria-hidden />,
    textClass: "text-muted line-through",
  },
};

const EMPTY_TASKS: readonly TaskItem[] = [];

function TaskListRow({ task }: { task: TaskItem }) {
  const view = TASK_STATUS_VIEW[task.status];
  const text = task.status === "in_progress" ? task.activeForm ?? task.content : task.content;
  return (
    // The running task takes the slash menu's active-row fill, so the eye lands on it first.
    <li className={cn("flex h-8 items-center gap-2 rounded-full px-2", task.status === "in_progress" && "bg-ink/7")}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">{view.mark}</span>
      <span className={cn("text-fade flex-1 text-compact", view.textClass)}>
        <span className="sr-only">{view.label}: </span>
        {text}
      </span>
    </li>
  );
}

function TaskList({ threadId, id }: { threadId: string; id: string }) {
  const tasks = useTaskStore((s) => s.taskBubbleByThread[threadId]?.tasks ?? EMPTY_TASKS);
  // Focusable so keyboard users can scroll a list taller than the 262px cap the slash menu shares.
  return (
    <ul
      id={id}
      aria-label="Tasks"
      tabIndex={0}
      className="scroll-fade-y m-0 max-h-[262px] list-none rounded-control p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      {tasks.map((task) => (
        <TaskListRow key={task.id} task={task} />
      ))}
    </ul>
  );
}

function SegmentLane({ segments }: { segments: readonly TaskSegment[] }) {
  // Capped at the width of 12 segments; longer lists shrink each segment
  // (down to 2px) so the lane stays a quiet accent beside the title.
  return (
    <span className="flex max-w-[8.2rem] shrink-0 items-center gap-0.5 overflow-hidden" aria-hidden>
      {segments.map((segment, index) => (
        <span
          key={index}
          data-segment={segment}
          className={cn("h-[3px] w-2.5 min-w-0.5 shrink rounded-full", SEGMENT_CLASS[segment])}
        />
      ))}
    </span>
  );
}

interface TaskRowProps {
  readonly progress: TaskProgress;
  readonly expanded: boolean;
  readonly listId: string;
  readonly chevronRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}

function TaskRow({ progress, expanded, listId, chevronRef, onToggle }: TaskRowProps) {
  // The chevron is the keyboard control; the rest of the row is a larger pointer target.
  return (
    <div
      role="group"
      aria-label={`${progress.title}, ${progress.settled} of ${progress.total} done`}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-full pr-0.5 pl-2 hover:bg-hover"
      onClick={onToggle}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <ListChecks className="size-3.5 text-muted" aria-hidden />
      </span>
      <span className="text-fade flex-1 text-body-small text-ink">{progress.title}</span>
      <SegmentLane segments={progress.segments} />
      <span className="shrink-0 text-compact tabular-nums text-muted">
        {progress.settled}/{progress.total}
      </span>
      <IconButton
        ref={chevronRef}
        size="inline-sm"
        aria-label={expanded ? "Hide tasks" : "Show tasks"}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        className="shrink-0 rounded-full text-muted"
      >
        <ChevronUp
          className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-180")}
        />
      </IconButton>
    </div>
  );
}

interface DockedTaskListProps extends TaskRowProps {
  readonly threadId: string;
  readonly listContainerRef: RefObject<HTMLDivElement | null>;
}

/** The task row with its list expanded above it, so the list grows the tray upward. */
function DockedTaskList({ threadId, listContainerRef, ...row }: DockedTaskListProps) {
  return (
    <>
      {row.expanded && (
        <div ref={listContainerRef} className="flex min-h-0 flex-col">
          <TaskList threadId={threadId} id={row.listId} />
          <div role="separator" className="mx-2 my-1 h-px bg-border" />
        </div>
      )}
      <TaskRow {...row} />
    </>
  );
}

/** Props for {@link ComposerTray}. */
export interface ComposerTrayProps {
  readonly threadId: string;
  /** True while the thread's agent runs; a running thread has no usage-limit row. */
  readonly running: boolean;
  readonly queue: ReactNode;
  /** The draft's file and image tiles; the tray shows whenever it has any, like queued messages. */
  readonly tiles?: ReactNode;
  /** True while the slash menu covers the tray; its controls are then inert. */
  readonly covered?: boolean;
}

/** The panel the tray and the new-thread tab share above the capsule. */
export const TRAY_SURFACE_CLASS = "mx-(--tray-inset) rounded-t-[14px] bg-panel";

/**
 * Tray look: inset by `--tray-inset` from the capsule, which the slash menu shares, with the panel fill and top corners.
 * Under the new-thread tab it drops its top corners, so the tab and the tray read as one panel.
 * Covered by the menu, the tray hides its rows but keeps its panel, so a menu shorter than the tray reads as one surface.
 */
export function composerTrayClass(covered: boolean): string {
  return cn(
    TRAY_SURFACE_CLASS,
    "flex flex-col gap-1 px-2 pt-1 pb-2 [[data-tray-tab]+&]:rounded-t-none",
    covered && "*:invisible",
  );
}

/**
 * Tray docked on top of the composer. Shows a usage-limit stop as the first
 * row, then the thread's parent-agent task list as one row, with the queued
 * messages and the draft's tiles below it; expanding the task list grows the tray upward so the
 * composer stays put.
 */
export function ComposerTray({ threadId, running, queue, tiles, covered = false }: ComposerTrayProps) {
  const usageLimit = useUsageLimitTray(threadId, running);
  const variant = useTasksVariant();
  const progress = useTrayTaskProgress(threadId, variant);
  const expanded = useTaskStore((s) => s.trayExpandedByThread[threadId] ?? false);
  const setExpanded = (next: boolean) => useTaskStore.getState().setTrayExpanded(threadId, next);
  const listId = useId();
  const chevronRef = useRef<HTMLButtonElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const hasQueue = useQueueStore((s) => (s.queues[threadId]?.length ?? 0) > 0);

  if (!usageLimit && !progress && !hasQueue && !tiles) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !expanded) return;
    event.stopPropagation();
    const focusWasInList = listContainerRef.current?.contains(document.activeElement) ?? false;
    setExpanded(false);
    if (focusWasInList) chevronRef.current?.focus();
  };

  return (
    <div
      data-testid="composer-tray"
      inert={covered}
      className={composerTrayClass(covered)}
      onKeyDown={handleKeyDown}
    >
      {usageLimit && <UsageLimitRow threadId={threadId} state={usageLimit} />}
      {progress && (variant === "C" ? <CurrentStepTray threadId={threadId} /> : (
        <DockedTaskList
          threadId={threadId}
          progress={progress}
          expanded={expanded}
          listId={listId}
          chevronRef={chevronRef}
          listContainerRef={listContainerRef}
          onToggle={() => setExpanded(!expanded)}
        />
      ))}
      {queue}
      {tiles}
    </div>
  );
}
