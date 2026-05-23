import { useCallback, useRef, useState } from "react";
import type { TaskItem } from "@/stores/taskStore";
import { PlanPanel } from "./plan";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import { TaskPanel } from "@/components/tasks/TaskPanel";

interface ScopeSplitPaneProps {
  threadId: string;
  parentTasks: readonly TaskItem[];
}

/** Minimum height for the task section in pixels. */
const TASKS_MIN_H = 80;
/** Minimum height for the plan section in pixels. */
const PLAN_MIN_H = 120;

/**
 * Vertical split pane for the Scope tab: plan document on top, tasks
 * on the bottom, with a draggable divider between them.
 *
 * The split ratio is stored as a percentage of the container height
 * allocated to the task section (bottom). Dragging the handle adjusts
 * this ratio. Both sections scroll independently.
 */
export function ScopeSplitPane({ threadId, parentTasks }: ScopeSplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [taskPct, setTaskPct] = useState(35);
  const draggingRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const container = containerRef.current;
      if (!container) return;

      const startY = e.clientY;
      const containerRect = container.getBoundingClientRect();
      const containerH = containerRect.height;
      const startTaskH = containerH * (taskPct / 100);

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const deltaY = ev.clientY - startY;
        // Dragging up = more tasks, dragging down = less tasks
        const newTaskH = Math.max(
          TASKS_MIN_H,
          Math.min(containerH - PLAN_MIN_H, startTaskH - deltaY),
        );
        setTaskPct((newTaskH / containerH) * 100);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [taskPct],
  );

  // Double-click resets to default split
  const onDoubleClick = useCallback(() => {
    setTaskPct(35);
  }, []);

  // Keyboard accessibility for the drag handle
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 5;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setTaskPct((p) => Math.min(90, p + step));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setTaskPct((p) => Math.max(10, p - step));
      }
    },
    [],
  );

  return (
    <div ref={containerRef} className="flex flex-1 flex-col min-h-0">
      {/* Plan section: flex-1 with basis-0 so content height never expands the split pane. */}
      <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
        <PlanPanel threadId={threadId} />
      </div>

      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize plan and tasks sections"
        tabIndex={0}
        onMouseDown={onDragStart}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        className="group flex h-[9px] flex-shrink-0 cursor-row-resize items-center justify-center border-y border-border/50 bg-background transition-colors hover:bg-accent/50"
      >
        <div className="h-[2px] w-8 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-muted-foreground/40" />
      </div>

      {/* Task section: sized by taskPct */}
      <div
        className="flex flex-col flex-shrink-0 overflow-hidden"
        style={{ height: `${taskPct}%`, minHeight: TASKS_MIN_H }}
      >
        <TaskPanelHeader tasks={parentTasks} />
        <TaskPanel />
      </div>
    </div>
  );
}
