// PROTOTYPE (throwaway): where the parent agent's task list lives, and what it looks like.
// Placements on the real thread view, switched by `?tasks=<key>` or ← / → (dev builds only).
// Round 3 makes the composer's border the progress (TasksRim.prototype.tsx). The list only opens when asked; the count
// is the open question, so each variant answers it differently:
//   E1 Rim + count   – the top edge is split into one segment per task; "3/9" is set into the border at its right end.
//   E2 Trace         – the whole outline fills clockwise; the count appears while you hover or type, and when a step finishes.
//   E3 Segment ring  – the whole outline is split into one segment per task; "Tasks 3/9" is set into the border at its left end.
// Round 2 explores the progress chip (TasksChips.prototype.tsx); every chip variant keeps tasks out of the tray and overview:
//   B1 Count chip    – pie + "2/9" beside `+`; hover opens the checklist.
//   B2 Ghost step    – B1, plus the empty composer's placeholder names the step in flight.
//   B3 Island        – a pill riding the capsule's top edge; click opens the checklist above it.
//   B4 Lit edge      – the capsule's top border fills with progress; a count chip sits by Send.
//   B5 Header chip   – the chip lives in the thread header beside the title.
// Round 1, kept for comparison:
//   A Docked list    – the restyled tray row above the capsule; overview shows nothing.
//   C Current step   – the tray shows only the step in flight; expanding shows a numbered stepper.
//   D Overview card  – the composer shows nothing; the overview card owns an inline checklist.
// Every chip announces a finished step for a moment ("step" in the switcher advances one).
// Delete this folder and its call sites once a variant wins.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, ListChecks, X } from "lucide-react";
import { PrototypeSwitcher } from "@/components/dev/PrototypeSwitcher";
import { cn } from "@/lib/utils";
import {
  useTaskProgress,
  useTaskStore,
  type TaskItem,
  type TaskProgress,
  type TaskSegment,
  type TaskStatus,
} from "@/stores/taskStore";

export type TasksVariant = "E1" | "E2" | "E3" | "B1" | "B2" | "B3" | "B4" | "B5" | "A" | "C" | "D";

const VARIANTS = [
  { key: "E1", name: "Rim + count" },
  { key: "E2", name: "Trace" },
  { key: "E3", name: "Segment ring" },
  { key: "B1", name: "Count chip (r2)" },
  { key: "B2", name: "Ghost step (r2)" },
  { key: "B3", name: "Island (r2)" },
  { key: "B4", name: "Lit edge (r2)" },
  { key: "B5", name: "Header chip (r2)" },
  { key: "A", name: "Docked list (r1)" },
  { key: "C", name: "Current step (r1)" },
  { key: "D", name: "Overview card (r1)" },
] as const satisfies readonly { key: TasksVariant; name: string }[];

const VARIANT_EVENT = "mcode:tasks-variant";

function readVariant(): TasksVariant {
  const raw = new URLSearchParams(window.location.search).get("tasks");
  return VARIANTS.find((variant) => variant.key === raw)?.key ?? "E1";
}

function writeVariant(next: TasksVariant): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tasks", next);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(VARIANT_EVENT));
}

function subscribeVariant(onChange: () => void): () => void {
  window.addEventListener(VARIANT_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(VARIANT_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** True in the dev app only. Tests run in dev mode too, but must keep exercising the shipped tray and overview row. */
export const TASKS_PROTOTYPE_ACTIVE = import.meta.env.DEV && import.meta.env.MODE !== "test";

/** The active prototype variant. Production builds and tests always get A, the shipped tray. */
export function useTasksVariant(): TasksVariant {
  const variant = useSyncExternalStore<TasksVariant>(subscribeVariant, readVariant, () => "A");
  return TASKS_PROTOTYPE_ACTIVE ? variant : "A";
}

/** The task progress the composer tray shows: the chips keep tasks in their chip and D in the overview card, so their tray has none. */
export function useTrayTaskProgress(threadId: string, variant: TasksVariant): TaskProgress | null {
  const progress = useTaskProgress(threadId);
  return variant === "A" || variant === "C" ? progress : null;
}

// ---------------------------------------------------------------------------
// Seed data, so every variant can be judged at 3, 9 and 24 tasks and when finished.

function task(id: string, status: TaskStatus, content: string, activeForm?: string): TaskItem {
  return { id, status, content, group: "Tasks", ...(activeForm ? { activeForm } : {}) };
}

const NINE: readonly TaskItem[] = [
  task("1", "completed", "Read the composer tray and task store to map how progress reaches the UI"),
  task("2", "completed", "Trace where TodoWrite events become task items in the Claude adapter"),
  task("3", "in_progress", "Rework the tray header into a 32px row that matches the capsule parts", "Reworking the tray header to match the capsule parts"),
  task("4", "pending", "Move the full checklist into a popover anchored on the capsule"),
  task("5", "pending", "Drop the Tasks row from the thread overview card"),
  task("6", "pending", "Add a regression test for Escape closing the expanded list"),
  task("7", "pending", "Check the light and dark themes against the DESIGN.md tokens"),
  task("8", "pending", "Record before and after captures in Electron"),
  task("9", "pending", "Open the pull request with the captures attached"),
];

const SEEDS: Record<string, readonly TaskItem[] | null> = {
  "3": NINE.slice(1, 4),
  "9": NINE,
  "24": Array.from({ length: 24 }, (_, index) => {
    const base = NINE[index % NINE.length]!;
    const status: TaskStatus = index < 10 ? "completed" : index === 10 ? "in_progress" : "pending";
    return task(String(index + 1), status, `${base.content}${index >= NINE.length ? ` (pass ${Math.floor(index / NINE.length) + 1})` : ""}`, base.activeForm ?? `${base.content}…`);
  }),
  done: NINE.map((item, index) => ({ ...item, status: index === 6 ? "cancelled" : "completed" })),
  clear: null,
};

/** Finishes the step in flight and starts the next, so the chips' step transition can be watched. */
function advance(tasks: readonly TaskItem[]): readonly TaskItem[] {
  const current = tasks.findIndex((item) => item.status === "in_progress");
  const next = tasks.findIndex((item, index) => index > current && item.status === "pending");
  return tasks.map((item, index): TaskItem => {
    if (index === current) return { ...item, status: "completed" };
    if (index === next) return { ...item, status: "in_progress" };
    return item;
  });
}

function seed(threadId: string, key: string): void {
  if (key === "step") {
    const tasks = useTaskStore.getState().taskBubbleByThread[threadId]?.tasks;
    if (tasks) useTaskStore.getState().setTasks(threadId, advance(tasks), null);
    return;
  }
  const tasks = SEEDS[key];
  if (tasks) useTaskStore.getState().setTasks(threadId, tasks, null);
  else useTaskStore.getState().clearTasks(threadId);
}

/** The floating variant bar plus seed buttons for the given thread. Dev builds only. */
export function TasksPrototypeBar({ threadId }: { readonly threadId: string }) {
  const variant = useTasksVariant();
  if (!TASKS_PROTOTYPE_ACTIVE) return null;
  return (
    <PrototypeSwitcher
      variants={VARIANTS}
      current={variant}
      onChange={writeVariant}
      extra={[...Object.keys(SEEDS), "step"].map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => seed(threadId, key)}
          className="h-7 rounded-full px-2 tabular-nums text-background/75 hover:bg-background/15 hover:text-background"
        >
          {key}
        </button>
      ))}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared marks. Each variant owns its own layout.

const EMPTY_TASKS: readonly TaskItem[] = [];

/** The thread's parent-agent tasks, all statuses. */
export function useTasks(threadId: string): readonly TaskItem[] {
  return useTaskStore((s) => s.taskBubbleByThread[threadId]?.tasks ?? EMPTY_TASKS);
}

/** What a task reads as: the present-tense form while it runs. */
export function taskText(item: TaskItem): string {
  return item.status === "in_progress" ? item.activeForm ?? item.content : item.content;
}

/** The task's status glyph: check, cross, filled dot (running) or hollow dot (pending). */
export function StatusMark({ status }: { readonly status: TaskStatus }) {
  if (status === "completed") return <Check className="size-3.5 text-muted" aria-hidden />;
  if (status === "cancelled") return <X className="size-3.5 text-muted" aria-hidden />;
  if (status === "in_progress") return <span className="size-1.5 rounded-full bg-ink" aria-hidden />;
  return <span className="size-1.5 rounded-full border border-muted" aria-hidden />;
}

const SEGMENT_CLASS: Record<TaskSegment, string> = { done: "bg-ink", current: "bg-muted", pending: "bg-border" };

/** One segment per task, filled by status. */
export function SegmentBar({ segments, className }: { readonly segments: readonly TaskSegment[]; readonly className?: string }) {
  return (
    <span className={cn("flex items-center gap-0.5", className)} aria-hidden>
      {segments.map((segment, index) => (
        <span key={index} className={cn("h-[3px] min-w-0.5 flex-1 rounded-full", SEGMENT_CLASS[segment])} />
      ))}
    </span>
  );
}

function ChecklistRow({ item, className }: { readonly item: TaskItem; readonly className?: string }) {
  const active = item.status === "in_progress";
  return (
    <li className={cn("flex h-8 items-center gap-2 rounded-full px-2", active && "bg-ink/7", className)}>
      <span className="flex size-3.5 shrink-0 items-center justify-center"><StatusMark status={item.status} /></span>
      <span className={cn("text-fade flex-1 text-compact", active ? "text-ink" : "text-muted", item.status === "cancelled" && "line-through")}>
        {taskText(item)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// C · Current step

function stepMarker(item: TaskItem, number: number): ReactNode {
  if (item.status === "in_progress") {
    return <span className="flex size-5 items-center justify-center rounded-full bg-ink text-caption tabular-nums text-background">{number}</span>;
  }
  return <span className="flex size-5 items-center justify-center rounded-full border border-border bg-panel text-caption tabular-nums text-muted">{number}</span>;
}

function Stepper({ tasks }: { readonly tasks: readonly TaskItem[] }) {
  const [showDone, setShowDone] = useState(false);
  const settled = tasks.filter((item) => item.status === "completed" || item.status === "cancelled");
  const open = tasks.filter((item) => item.status === "in_progress" || item.status === "pending");
  return (
    <div className="scroll-fade-y max-h-[300px] pb-1">
      {settled.length > 0 && (
        <button
          type="button"
          onClick={() => setShowDone(!showDone)}
          className="flex h-7 w-full items-center gap-2 rounded-full px-2.5 text-compact text-muted hover:bg-hover hover:text-ink"
        >
          <Check className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">{settled.length} done</span>
          {showDone ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
      )}
      {showDone && (
        <ul className="m-0 list-none p-0 pl-1">
          {settled.map((item) => <ChecklistRow key={item.id} item={item} className="h-7" />)}
        </ul>
      )}
      <ol className="relative m-0 list-none p-0">
        {/* The rail ties the steps into one sequence; markers sit on top of it. */}
        <span className="absolute top-3 bottom-3 left-[19px] w-px bg-border" aria-hidden />
        {open.map((item) => {
          const number = tasks.indexOf(item) + 1;
          const active = item.status === "in_progress";
          return (
            <li key={item.id} className={cn("relative flex items-start gap-2.5 px-2.5", active ? "py-1" : "py-0.5")}>
              <span className="relative mt-1 shrink-0">{stepMarker(item, number)}</span>
              <span
                className={cn(
                  "min-w-0 flex-1 rounded-lg",
                  active ? "text-fade-lines-2 bg-ink/7 px-2.5 py-1 text-body-small text-ink" : "text-fade py-1 text-compact text-muted",
                )}
              >
                {taskText(item)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function currentStepLabels(progress: TaskProgress, tasks: readonly TaskItem[]): { readonly text: string; readonly count: string } {
  const current = tasks.find((item) => item.status === "in_progress") ?? tasks.find((item) => item.status === "pending");
  if (progress.settled === progress.total || !current) {
    return { text: `${progress.title} finished`, count: `${progress.total} of ${progress.total}` };
  }
  return { text: taskText(current), count: `Step ${tasks.indexOf(current) + 1} of ${progress.total}` };
}

/** C: the tray as a "now playing" row for the step in flight, with a stepper above it. */
export function CurrentStepTray({ threadId }: { readonly threadId: string }) {
  const progress = useTaskProgress(threadId);
  const tasks = useTasks(threadId);
  const expanded = useTaskStore((s) => s.trayExpandedByThread[threadId] ?? false);
  if (!progress) return null;
  const finished = progress.settled === progress.total;
  const labels = currentStepLabels(progress, tasks);
  const ratio = progress.total === 0 ? 0 : progress.settled / progress.total;
  const toggle = () => useTaskStore.getState().setTrayExpanded(threadId, !expanded);
  return (
    <div className="flex flex-col">
      {expanded && <Stepper tasks={tasks} />}
      <div
        role="group"
        aria-label={`${progress.title}, ${progress.settled} of ${progress.total} done`}
        onClick={toggle}
        className="relative flex h-8 cursor-pointer items-center gap-2.5 rounded-full pr-1 pl-2.5 hover:bg-hover"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {finished ? <Check className="size-3.5 text-ink" aria-hidden /> : <span className="size-1.5 rounded-full bg-ink" aria-hidden />}
        </span>
        <span className="text-fade flex-1 text-body-small text-ink">{labels.text}</span>
        <span className="shrink-0 text-compact tabular-nums text-muted">{labels.count}</span>
        <button
          type="button"
          aria-label={expanded ? "Hide tasks" : "Show tasks"}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:text-ink"
        >
          <ChevronUp className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-180")} />
        </button>
      </div>
      {/* A hairline under the row carries overall progress, so the row itself can spend its width on the step. */}
      <span className="mx-3 mt-0.5 h-0.5 overflow-hidden rounded-full bg-border" aria-hidden>
        <span className="block h-full rounded-full bg-ink" style={{ width: `${ratio * 100}%` }} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D · Overview card

const OVERVIEW_PEEK = 4;

/** The rows the collapsed card shows: the last finished step for context, then the step in flight and what follows. */
function peekWindow(tasks: readonly TaskItem[]): readonly TaskItem[] {
  const focus = tasks.findIndex((item) => item.status === "in_progress" || item.status === "pending");
  const start = focus === -1 ? Math.max(0, tasks.length - OVERVIEW_PEEK) : Math.max(0, focus - 1);
  return tasks.slice(start, start + OVERVIEW_PEEK);
}

/** D: the overview card's Tasks section as an inline checklist. Renders only in variant D. */
export function OverviewTasksChecklist({ threadId }: { readonly threadId: string }) {
  const progress = useTaskProgress(threadId);
  const tasks = useTasks(threadId);
  const [showAll, setShowAll] = useState(false);
  if (!progress) return null;
  const visible = showAll ? tasks : peekWindow(tasks);
  const hidden = tasks.length - visible.length;
  return (
    <div data-testid="thread-overview-tasks" className="flex flex-col pb-1">
      <div className="flex h-row-compact items-center gap-2 px-3 text-body-small">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted [&_svg]:size-4" aria-hidden><ListChecks /></span>
        <span className="text-fade min-w-0 grow text-ink">{progress.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted">{progress.settled}/{progress.total}</span>
      </div>
      <SegmentBar segments={progress.segments} className="mx-3 mb-1.5 ml-10" />
      <ul aria-label="Tasks" className={cn("m-0 list-none p-0", showAll && "scroll-fade-y max-h-[240px]")}>
        {visible.map((item) => (
          <li key={item.id} className={cn("mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5", item.status === "in_progress" && "bg-ink/7")}>
            <span className="flex size-5 shrink-0 items-center justify-center"><StatusMark status={item.status} /></span>
            <span className={cn("text-fade flex-1 text-compact", item.status === "in_progress" ? "text-ink" : "text-muted")}>{taskText(item)}</span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || showAll) && tasks.length > OVERVIEW_PEEK && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mx-1.5 flex h-7 items-center rounded-md px-1.5 pl-[34px] text-left text-compact text-muted hover:bg-hover hover:text-ink"
        >
          {showAll ? "Show less" : `Show all ${tasks.length}`}
        </button>
      )}
    </div>
  );
}
