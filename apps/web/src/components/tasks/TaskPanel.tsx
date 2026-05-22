import { useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskGroup } from "./TaskGroup";

/** Task panel content rendered inside the RightPanel wrapper. */
export function TaskPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  const groups = useMemo(() => {
    if (!tasks) return [];
    // Only show top-level agent tasks; sub-agent groups are noise in the panel
    const parentTasks = tasks.filter((t) => t.group === "Tasks");
    if (parentTasks.length === 0) return [];
    return [["Tasks", parentTasks] as const];
  }, [tasks]);

  const hasTasks = tasks && tasks.length > 0;

  return hasTasks ? (
    <ScrollArea className="flex-1">
      <div className="flex flex-col py-1">
        {groups.map(([name, items]) => (
          <TaskGroup
            key={name}
            name={name}
            tasks={items}
            hideHeader={groups.length === 1 && name === "Tasks"}
          />
        ))}
      </div>
    </ScrollArea>
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <span aria-hidden="true" className="font-mono text-[24px] leading-none text-muted-foreground/15">
        ∅
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/40">
        Nothing on the docket
      </p>
    </div>
  );
}
