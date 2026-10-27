import { useCallback, useEffect } from "react";
import { Plus } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStartupRecovery } from "@/features/thread-startup/state/thread-startup-store";
import { ProjectDropWell } from "../ProjectDropWell";
import { useProjectTreeMenus } from "../ProjectTree";
import { useWorkspaceStore } from "../state/workspaceStore";
import { ScopeBar } from "./ScopeBar";
import { SidebarList } from "./SidebarList";
import { useRowLifecycleStore } from "./row-lifecycle-store";
import { useSidebarModel } from "./use-sidebar-model";

function SidebarProjectsHeader() {
  // The palette's folder-browse view works across Electron and standalone web without the desktop bridge.
  const openFolder = useCallback(() => useCommandPaletteStore.getState().open({ intent: "addProject" }), []);
  return (
    <div className="mx-1.5 flex h-8 shrink-0 items-center gap-1 pl-2">
      <span className="min-w-0 flex-1 text-label text-muted">Projects</span>
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
  const { model } = useSidebarModel();
  const { ctx, overlays } = useProjectTreeMenus();
  const hasProjects = useWorkspaceStore((s) => s.workspaces.length > 0);
  const error = useWorkspaceStore((s) => s.error);
  useWorkspaceLoading();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
      <SidebarProjectsHeader />
      <ScopeBar />
      <SidebarList
        items={model.items}
        ctx={ctx}
        overlay={hasProjects ? null : <div className="absolute inset-x-1.5 inset-y-0"><ProjectDropWell /></div>}
      />
      {error && <p className="px-3 py-1 text-xs text-destructive">{error}</p>}
      {overlays}
    </div>
  );
}
