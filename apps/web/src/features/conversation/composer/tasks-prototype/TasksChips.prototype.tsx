// PROTOTYPE (throwaway): round 2 of the task-progress chip, five placements (B1 to B5).
// See TasksPrototype.prototype.tsx for the variant list. Delete with that folder once a variant wins.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useTaskProgress, type TaskItem, type TaskProgress } from "@/stores/taskStore";
import { SegmentBar, StatusMark, taskText, useTasks, useTasksVariant, type TasksVariant } from "./TasksPrototype.prototype";

const PIE_RADIUS = 2.5;
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;
/** How long a chip announces the step that just finished before it returns to progress. */
const FLASH_MS = 2400;
export const ENTER = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none";

function isSettled(item: TaskItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function currentTask(tasks: readonly TaskItem[]): TaskItem | undefined {
  return tasks.find((item) => item.status === "in_progress") ?? tasks.find((item) => item.status === "pending");
}

/**
 * A filled pie, not an arc: a partial ring reads as a spinner. A dash on a fat stroke draws the wedge, so a finished
 * step grows it once with a CSS transition instead of jumping.
 */
function ProgressPie({ progress }: { readonly progress: TaskProgress }) {
  if (progress.total > 0 && progress.settled === progress.total) return <Check className="size-3.5 shrink-0 text-ink" aria-hidden />;
  const ratio = progress.total === 0 ? 0 : progress.settled / progress.total;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={7} cy={7} r={6} fill="none" strokeWidth={1.25} className="stroke-muted" />
      <circle
        cx={7}
        cy={7}
        r={PIE_RADIUS}
        fill="none"
        strokeWidth={PIE_RADIUS * 2}
        strokeDasharray={`${ratio * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`}
        className="stroke-ink transition-[stroke-dasharray] duration-500 ease-(--ease-standard) motion-reduce:transition-none"
      />
    </svg>
  );
}

/** The task that finished most recently, for {@link FLASH_MS}; null on first render so opening a thread stays quiet. */
function useStepFlash(tasks: readonly TaskItem[]): TaskItem | null {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const [flash, setFlash] = useState<TaskItem | null>(null);
  useEffect(() => {
    const done = tasks.filter((item) => item.status === "completed");
    const previous = seen.current;
    seen.current = new Set(done.map((item) => item.id));
    const fresh = previous ? done.filter((item) => !previous.has(item.id)).at(-1) : undefined;
    if (fresh) setFlash(fresh);
  }, [tasks]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  return flash;
}

/** What every task chip renders from. */
export interface ChipState {
  readonly progress: TaskProgress;
  readonly tasks: readonly TaskItem[];
  readonly flash: TaskItem | null;
}

/** Progress, tasks and the finished-step flash for one thread, or null when the variant is not active or there are no tasks. */
/** Progress, tasks and finished-step flash, or null unless one of `variants` is active and the thread has tasks. */
export function useChip(threadId: string, variants: readonly TasksVariant[]): (ChipState & { readonly variant: TasksVariant }) | null {
  const variant = useTasksVariant();
  const progress = useTaskProgress(threadId);
  const tasks = useTasks(threadId);
  const flash = useStepFlash(tasks);
  if (!variants.includes(variant) || !progress) return null;
  return { variant, progress, tasks, flash };
}

/** What a chip shows: the step that just finished, else the pie, optionally the step in flight, and the count. */
function ChipFace({ progress, tasks, flash, showStep, stepWidth = "max-w-[260px]" }: ChipState & { readonly showStep: boolean; readonly stepWidth?: string }) {
  if (flash) {
    return (
      <span key={`flash-${flash.id}`} className={cn("flex min-w-0 items-center gap-1.5", ENTER)}>
        <Check className="size-3.5 shrink-0 text-ink" aria-hidden />
        <span className={cn("text-fade text-ink", stepWidth)}>{flash.content}</span>
      </span>
    );
  }
  const current = showStep ? currentTask(tasks) : undefined;
  return (
    <>
      <ProgressPie progress={progress} />
      {current && <span key={current.id} className={cn("text-fade min-w-0 text-ink", stepWidth, ENTER)}>{taskText(current)}</span>}
      <span className="shrink-0 tabular-nums">{progress.settled}/{progress.total}</span>
    </>
  );
}

function PanelRow({ item }: { readonly item: TaskItem }) {
  if (item.status === "in_progress") {
    return (
      <li className="flex items-start gap-2 rounded-xl bg-ink/7 px-2 py-1.5">
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center"><StatusMark status={item.status} /></span>
        <span className="text-fade-lines-2 flex-1 text-body-small text-ink">{taskText(item)}</span>
      </li>
    );
  }
  return (
    <li className="flex h-8 items-center gap-2 rounded-full px-2">
      <span className="flex size-3.5 shrink-0 items-center justify-center"><StatusMark status={item.status} /></span>
      <span className={cn("text-fade flex-1 text-compact text-muted", item.status === "cancelled" && "line-through")}>{taskText(item)}</span>
    </li>
  );
}

/** The checklist every chip opens: finished steps fold into one row while work remains, so the step in flight leads. */
function TaskPanel({ progress, tasks }: { readonly progress: TaskProgress; readonly tasks: readonly TaskItem[] }) {
  const [showDone, setShowDone] = useState(false);
  const settledCount = tasks.filter(isSettled).length;
  const foldDone = settledCount > 0 && settledCount < tasks.length;
  const visible = foldDone && !showDone ? tasks.filter((item) => !isSettled(item)) : tasks;
  return (
    <>
      <div className="flex items-baseline gap-2 px-2 pt-1">
        <span className="text-fade flex-1 text-label text-ink">{progress.title}</span>
        <span className="shrink-0 text-compact tabular-nums text-muted">{progress.settled} of {progress.total}</span>
      </div>
      <SegmentBar segments={progress.segments} className="mx-2 mt-2 mb-1.5" />
      {foldDone && (
        <button
          type="button"
          onClick={() => setShowDone(!showDone)}
          className="flex h-8 w-full items-center gap-2 rounded-full px-2 text-compact text-muted hover:bg-hover hover:text-ink"
        >
          <Check className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">{settledCount} done</span>
          {showDone ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
      )}
      <ul aria-label="Tasks" className="scroll-fade-y m-0 max-h-[300px] list-none p-0">
        {visible.map((item) => <PanelRow key={item.id} item={item} />)}
      </ul>
    </>
  );
}

/**
 * The finished step, floated above a chip instead of written into it: the capsule lays out its row from the chip's
 * width, so a chip that grew for the announcement would push the draft to a second row and back.
 */
function FlashReceipt({ item, edge }: { readonly item: TaskItem; readonly edge: "start" | "end" }) {
  return (
    <span
      role="status"
      className={cn(
        "pointer-events-none absolute bottom-full mb-2.5 flex max-w-[320px] items-center gap-1.5 rounded-full bg-panel px-2.5 py-1 text-compact text-ink shadow-floating ring-1 ring-border",
        edge === "start" ? "left-0" : "right-0",
        ENTER,
      )}
    >
      <Check className="size-3.5 shrink-0" aria-hidden />
      <span className="text-fade min-w-0 whitespace-nowrap">{item.content}</span>
    </span>
  );
}

interface TasksPopoverProps extends ChipState {
  readonly side: "top" | "bottom";
  readonly align: "start" | "center" | "end";
  readonly hover?: boolean;
  /** Announce a finished step in a floating receipt on this edge rather than inside the chip. */
  readonly receipt?: "start" | "end";
  readonly className: string;
  readonly children: ReactNode;
}

/** A chip that opens the task checklist; the checklist never opens on its own. */
export function TasksPopover({ receipt, flash, ...props }: TasksPopoverProps) {
  if (!receipt) return <TasksPopoverTrigger {...props} />;
  return (
    <span className="relative inline-flex min-w-0 shrink-0">
      <TasksPopoverTrigger {...props} />
      {flash && <FlashReceipt key={flash.id} item={flash} edge={receipt} />}
    </span>
  );
}

function TasksPopoverTrigger({ progress, tasks, side, align, hover = true, className, children }: Omit<TasksPopoverProps, "receipt" | "flash">) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover={hover}
        delay={120}
        closeDelay={150}
        aria-label={`${progress.title}, ${progress.settled} of ${progress.total} done`}
        render={<button type="button" className={className} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side={side} align={align} sideOffset={14} alignOffset={align === "start" ? -8 : 0} className="w-[400px] p-1.5">
        <TaskPanel progress={progress} tasks={tasks} />
      </PopoverContent>
    </Popover>
  );
}

const CHIP_CLASS =
  "inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-compact text-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-button-secondary-hover data-popup-open:text-ink";

/** B1 and B2: a count chip beside `+`. A chip wide enough to name the step pushed the draft to a second row, so B2 names it in the placeholder instead. */
export function TasksCapsuleChip({ threadId }: { readonly threadId: string }) {
  const chip = useChip(threadId, ["B1", "B2"]);
  if (!chip) return null;
  return (
    <TasksPopover {...chip} side="top" align="start" receipt="start" className={CHIP_CLASS}>
      <ChipFace {...chip} flash={null} showStep={false} />
    </TasksPopover>
  );
}

const PLACEHOLDERS_TO_REPLACE = new Set(["Do anything", "Queue a follow-up"]);

/** B2: the empty composer's placeholder names the step in flight; any other placeholder (stale worktree, goal, branch) wins. */
export function useTasksPlaceholder(threadId: string | undefined, fallback: string): string {
  const variant = useTasksVariant();
  const tasks = useTasks(threadId ?? "");
  const current = tasks.find((item) => item.status === "in_progress");
  if (variant !== "B2" || !current || !PLACEHOLDERS_TO_REPLACE.has(fallback)) return fallback;
  return `Now: ${taskText(current)}`;
}

/** B4: a count chip in the right group, next to the model and Send. */
export function TasksRightChip({ threadId }: { readonly threadId: string }) {
  const chip = useChip(threadId, ["B4"]);
  if (!chip) return null;
  return (
    <TasksPopover {...chip} side="top" align="end" receipt="end" className={CHIP_CLASS}>
      <ListChecks className="size-3.5 shrink-0" aria-hidden />
      <span className="tabular-nums">{chip.progress.settled}/{chip.progress.total}</span>
    </TasksPopover>
  );
}

/** B3: a pill riding the capsule's top edge. Clicking pins the checklist, since a hover target this central would open by accident. */
function TasksIsland({ chip }: { readonly chip: ChipState }) {
  return (
    <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[60%]">
      <TasksPopover
        {...chip}
        side="top"
        align="center"
        hover={false}
        className="inline-flex h-6 max-w-[440px] items-center gap-2 rounded-full border border-border bg-selected pr-3 pl-2 text-compact text-muted shadow-floating outline-none hover:border-control-border hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:border-control-border data-popup-open:text-ink"
      >
        <ChipFace {...chip} showStep stepWidth="max-w-[320px]" />
      </TasksPopover>
    </div>
  );
}

/** B4: the capsule's top border fills with progress, inset past the rounded ends so it stays on the straight edge. */
function TasksLitEdge({ progress }: { readonly progress: TaskProgress }) {
  const ratio = progress.total === 0 ? 0 : progress.settled / progress.total;
  return (
    <span className="pointer-events-none absolute -top-px right-5 left-5 h-0.5" aria-hidden>
      <span
        className="block h-full rounded-full bg-ink transition-[width] duration-500 ease-(--ease-standard) motion-reduce:transition-none"
        style={{ width: `${ratio * 100}%` }}
      />
    </span>
  );
}

/** Capsule-level decoration for B3 (island) and B4 (lit edge). Rendered after the capsule row so it does not change the capsule's rounding. */
export function TasksCapsuleDecor({ threadId }: { readonly threadId: string }) {
  const chip = useChip(threadId, ["B3", "B4"]);
  if (!chip) return null;
  return chip.variant === "B3" ? <TasksIsland chip={chip} /> : <TasksLitEdge progress={chip.progress} />;
}

/** B5: the chip in the thread header, beside the title, opening downward. */
export function TasksHeaderChip({ threadId }: { readonly threadId: string }) {
  const chip = useChip(threadId, ["B5"]);
  if (!chip) return null;
  return (
    <TasksPopover {...chip} side="bottom" align="start" className={cn(CHIP_CLASS, "window-no-drag h-7 bg-selected")}>
      <ChipFace {...chip} showStep stepWidth="max-w-[220px]" />
    </TasksPopover>
  );
}
