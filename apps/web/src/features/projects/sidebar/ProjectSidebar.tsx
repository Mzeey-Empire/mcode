import { useCallback, useEffect } from "react";
import { List, ListTree, Plus } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStartupRecovery } from "@/features/thread-startup/state/thread-startup-store";
import { ProjectDropWell } from "../ProjectDropWell";
import { useProjectTreeMenus } from "../ProjectTree";
import { useWorkspaceStore } from "../state/workspaceStore";
import { CompletionUndoLine } from "./CompletionUndoLine";
import { ScopeBar } from "./ScopeBar";
import { SidebarList } from "./SidebarList";
import { useRowLifecycleStore } from "./row-lifecycle-store";
import { useSidebarUiStore } from "./sidebar-ui-store";
import { useSidebarModel } from "./use-sidebar-model";
import { useSidebarMotion } from "./sidebar-motion";

function SidebarProjectsHeader() {
  // The palette's folder-browse view works across Electron and standalone web without the desktop bridge.
  const openFolder = useCallback(() => useCommandPaletteStore.getState().open({ intent: "addProject" }), []);
  const view = useSidebarUiStore((s) => s.view);
  const toggleView = useSidebarUiStore((s) => s.toggleView);
  const ViewIcon = view === "projects" ? List : ListTree;
  return (
    <div className="mx-1.5 flex h-8 shrink-0 items-center gap-1 pl-2">
      <span className="min-w-0 flex-1 text-label text-muted">{view === "projects" ? "Projects" : "Threads"}</span>
      <IconButton aria-label={view === "projects" ? "Show as one list" : "Group by project"} onClick={toggleView}>
        <ViewIcon aria-hidden />
      </IconButton>
      <IconButton aria-label="Add project" onClick={openFolder}>
        <Plus aria-hidden />
      </IconButton>
    </div>
  );
}

function useWorkspaceLoading(): void {
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);
  useWorkspaceStartupRecovery(workspaces.map((workspace) => workspace.id));
  // In-flight row flags outlive any one row; tearing the sidebar down is where they should not linger.
  useEffect(() => () => useRowLifecycleStore.getState().reset(), []);
}

/**
 * The Projects sidebar: header, scope bar, and the one virtual list of derived items, plus the
 * menus and dialogs its rows open.
 */
export function ProjectSidebar() {
  const { model, cause } = useSidebarModel();
  const selectedThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const shown = useSidebarMotion(model, cause, selectedThreadId);
  const { ctx, overlays } = useProjectTreeMenus();
  const hasProjects = useWorkspaceStore((s) => s.workspaces.length > 0);
  const error = useWorkspaceStore((s) => s.error);
  useWorkspaceLoading();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
      <SidebarProjectsHeader />
      <ScopeBar visible={model.scopeBar.visible} completedCount={shown.completedCount} scope={model.scope} />
      <CompletionUndoLine onOpen={ctx.onSelectThread} flying={shown.flying} />
      <SidebarList
        items={shown.items}
        closing={shown.closing}
        arriving={shown.arriving}
        olderIds={model.olderIds}
        ctx={ctx}
        flip={cause === "push"}
        overlay={hasProjects ? null : <div className="absolute inset-x-1.5 inset-y-0"><ProjectDropWell /></div>}
      />
      {error && <p className="px-3 py-1 text-xs text-destructive">{error}</p>}
      {overlays}
    </div>
  );
}
