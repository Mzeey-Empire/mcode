import { useId } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTaskProgress, useTaskStore, type TaskItem, type TaskProgress, type TaskSegment } from "@/stores/taskStore";
import { taskProgressLabel } from "./task-tray-model";
import { TaskTray } from "./TaskTray";
import { useTaskTray } from "./useTaskTray";

const EMPTY_TASKS: readonly TaskItem[] = [];

/**
 * One task on the capsule's top border. Each transition is declared only on
 * the state it leads into, so entering done animates, leaving it snaps, and a
 * first mount paints without motion.
 */
function RimSegment({ segment }: { segment: TaskSegment }) {
  return (
    <span
      data-segment={segment}
      className={cn(
        "relative h-full min-w-px flex-1 overflow-hidden rounded-full",
        segment === "current" &&
          "bg-muted transition-[background-color] delay-380 duration-160 ease-(--ease-standard) motion-reduce:transition-none",
      )}
    >
      <span
        className={cn(
          "absolute inset-0 origin-left bg-ink",
          segment === "done"
            ? "scale-x-100 transition-transform duration-460 ease-(--ease-standard) motion-reduce:transition-none"
            : "scale-x-0",
        )}
      />
    </span>
  );
}

function TabCount({ progress }: { progress: TaskProgress }) {
  const count = `${progress.settled}/${progress.total}`;
  return (
    <span
      key={count}
      className="flex items-center gap-[4px] animate-in fade-in slide-in-from-bottom-[6px] duration-300 motion-reduce:animate-none"
    >
      {progress.settled === progress.total && <Check className="size-[12px]" aria-hidden />}
      {count}
    </span>
  );
}

/** Props for {@link ComposerTaskTab}. */
export interface ComposerTaskTabProps {
  readonly threadId: string;
  /** True while the slash menu covers the composer; the tab hides and the tray closes for good. */
  readonly covered: boolean;
}

/**
 * The parent agent's task progress on the composer's top edge: a count tab,
 * one segment per task on the capsule border, and a tray that grows out of the
 * tab when clicked. Renders nothing without tasks.
 */
export function ComposerTaskTab({ threadId, covered }: ComposerTaskTabProps) {
  const progress = useTaskProgress(threadId);
  const tasks = useTaskStore((s) => s.taskBubbleByThread[threadId]?.tasks ?? EMPTY_TASKS);
  const tray = useTaskTray(covered);
  const trayId = useId();
  if (!progress) return null;
  // `covered` closes the tray in an effect; checking it here keeps the tray off the menu for that frame.
  const mounted = tray.phase !== "closed" && !covered;
  return (
    <div ref={tray.rootRef} className="contents" onKeyDown={tray.onKeyDown}>
      <div
        inert={covered}
        className={cn(
          "pointer-events-none absolute right-[24px] bottom-[calc(100%-1px)] left-(--task-tab-left) flex items-end",
          covered && "invisible",
        )}
      >
        <button
          ref={tray.tabRef}
          type="button"
          data-task-tab
          aria-label={taskProgressLabel(progress)}
          aria-expanded={tray.phase === "open"}
          aria-controls={mounted ? trayId : undefined}
          onClick={tray.toggle}
          className={cn(
            "tab-fillets pointer-events-auto relative flex h-[21px] max-w-(--task-tab-max-width) shrink-0 items-center",
            "rounded-t-[10px] border border-b-0 border-border bg-selected px-[9px]",
            "text-caption text-muted tabular-nums hover:text-ink",
            "group-focus-within/capsule:border-control-border group-focus-within/capsule:[--tab-edge:var(--color-control-border)]",
            mounted && "invisible",
          )}
        >
          <TabCount progress={progress} />
        </button>
        <span className="ml-[14px] flex h-[2px] flex-1 gap-[3px]" aria-hidden>
          {progress.segments.map((segment, index) => (
            <RimSegment key={index} segment={segment} />
          ))}
        </span>
      </div>
      {mounted && (
        <TaskTray
          id={trayId}
          progress={progress}
          tasks={tasks}
          trayRef={tray.trayRef}
          headerRef={tray.headerRef}
          bodyRef={tray.bodyRef}
          onClose={tray.close}
        />
      )}
    </div>
  );
}
