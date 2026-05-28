import { StackedLayersIcon } from "./narrative/StackedLayersIcon";
import { countActiveSubagentCalls } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Shows "N subagents running" badge when subagents are active on the current thread. */
export function AgentStatusBar() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const toolCalls = useThreadRecord(activeThreadId, (r) => r.toolCalls);
  const count = countActiveSubagentCalls(toolCalls);

  if (count <= 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <StackedLayersIcon animated className="h-3 w-3 text-muted-foreground" />
      <span className="flex items-center gap-1.5 text-muted-foreground font-medium">
        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
        {count} subagent{count !== 1 ? "s" : ""} running
      </span>
    </div>
  );
}
