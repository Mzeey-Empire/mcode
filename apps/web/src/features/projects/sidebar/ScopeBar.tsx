import { useEffect } from "react";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useWorkspaceStore } from "../state/workspaceStore";
import { effectiveSidebarScope, useSidebarUiStore, type SidebarScope } from "./sidebar-ui-store";

function countCompleted(threads: readonly { readonly user_completed_at: string | null }[]): number {
  let count = 0;
  for (const thread of threads) if (thread.user_completed_at !== null) count += 1;
  return count;
}

/** Number of server-confirmed completed threads across every project. */
export function useCompletedThreadCount(): number {
  return useWorkspaceStore((state) => countCompleted(state.threads));
}

/** The scope the sidebar lists, already falling back to Active when nothing is completed. */
export function useSidebarScope(): SidebarScope {
  const scope = useSidebarUiStore((state) => state.scope);
  return effectiveSidebarScope(scope, useCompletedThreadCount());
}

function isSidebarScope(value: string): value is SidebarScope {
  return value === "active" || value === "completed";
}

/** Shows Active / Completed while completed threads exist; resets to Active when none remain. */
export function ScopeBar() {
  const completedCount = useCompletedThreadCount();
  const scope = useSidebarScope();
  const setScope = useSidebarUiStore((state) => state.setScope);

  useEffect(() => {
    if (completedCount === 0 && useSidebarUiStore.getState().scope !== "active") setScope("active");
  }, [completedCount, setScope]);

  if (completedCount === 0) return null;
  const options: readonly SegmentedOption[] = [
    { value: "active", label: "Active" },
    { value: "completed", label: "Completed", count: completedCount },
  ];
  return (
    <div data-testid="sidebar-scope-bar" className="mx-1.5 shrink-0">
      <SegmentedControl
        aria-label="Thread scope"
        size="compact"
        fill
        options={options}
        value={scope}
        onChange={(value) => {
          if (isSidebarScope(value)) setScope(value);
        }}
      />
    </div>
  );
}
