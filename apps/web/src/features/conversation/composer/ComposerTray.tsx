import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronUp, ListChecks, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useTaskProgress,
  useTaskStore,
  type TaskItem,
  type TaskProgress,
  type TaskSegment,
  type TaskStatus,
} from "@/stores/taskStore";

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
    mark: <Check className="size-4 text-muted" strokeWidth={1.5} aria-hidden />,
    textClass: "text-muted",
  },
  in_progress: {
    label: "In progress",
    mark: <span className="size-2 rounded-full bg-ink" aria-hidden />,
    textClass: "text-ink",
  },
  pending: {
    label: "Pending",
    mark: <span className="size-2 rounded-full border-[1.5px] border-border" aria-hidden />,
    textClass: "text-ink",
  },
  cancelled: {
    label: "Cancelled",
    mark: <X className="size-4 text-muted" strokeWidth={1.5} aria-hidden />,
    textClass: "text-muted line-through",
  },
};

const EMPTY_TASKS: readonly TaskItem[] = [];

function TaskListRow({ task }: { task: TaskItem }) {
  const view = TASK_STATUS_VIEW[task.status];
  const text = task.status === "in_progress" ? task.activeForm ?? task.content : task.content;
  return (
    <li className="flex h-10 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center">{view.mark}</span>
      <span className={cn("text-fade flex-1 text-body-small", view.textClass)}>
        <span className="sr-only">{view.label}: </span>
        {text}
      </span>
    </li>
  );
}

function TaskList({ threadId, id }: { threadId: string; id: string }) {
  const tasks = useTaskStore((s) => s.taskBubbleByThread[threadId]?.tasks ?? EMPTY_TASKS);
  // Focusable so keyboard users can scroll a list taller than six rows.
  return (
    <ul
      id={id}
      aria-label="Tasks"
      tabIndex={0}
      className="m-0 max-h-60 list-none overflow-y-auto rounded-control p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      {tasks.map((task) => (
        <TaskListRow key={task.id} task={task} />
      ))}
    </ul>
  );
}

function SegmentLane({ segments }: { segments: readonly TaskSegment[] }) {
  // Capped at the width of 20 segments; longer lists shrink each segment
  // (down to 2px) so the lane stays on one line.
  return (
    <span className="flex max-w-[27.8rem] shrink-0 items-center gap-0.5 overflow-hidden" aria-hidden>
      {segments.map((segment, index) => (
        <span
          key={index}
          data-segment={segment}
          className={cn("h-1 w-3 min-w-0.5 shrink rounded-[0.2rem]", SEGMENT_CLASS[segment])}
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
      className="flex h-10 cursor-pointer items-center gap-2"
      onClick={onToggle}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ListChecks className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
      </span>
      <span className="text-fade flex-1 text-label text-ink">{progress.title}</span>
      <SegmentLane segments={progress.segments} />
      <span className="shrink-0 text-body-small tabular-nums text-muted">
        {progress.settled}/{progress.total}
      </span>
      <IconButton
        ref={chevronRef}
        aria-label={expanded ? "Hide tasks" : "Show tasks"}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        className="shrink-0 text-muted"
      >
        <ChevronUp
          strokeWidth={1.5}
          className={cn("transition-transform duration-150", expanded && "rotate-180")}
        />
      </IconButton>
    </div>
  );
}

/**
 * Tray docked on top of the composer. Shows the thread's parent-agent task
 * list as one row; expanding it grows the tray upward so the composer stays put.
 */
export function ComposerTray({ threadId }: { threadId: string }) {
  const progress = useTaskProgress(threadId);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const chevronRef = useRef<HTMLButtonElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  if (!progress) return null;

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
      className="mx-3.5 flex flex-col rounded-t-[1.2rem] bg-panel px-2 py-1"
      onKeyDown={handleKeyDown}
    >
      {expanded && (
        <div ref={listContainerRef}>
          <TaskList threadId={threadId} id={listId} />
        </div>
      )}
      <TaskRow
        progress={progress}
        expanded={expanded}
        listId={listId}
        chevronRef={chevronRef}
        onToggle={() => setExpanded((open) => !open)}
      />
    </div>
  );
}
