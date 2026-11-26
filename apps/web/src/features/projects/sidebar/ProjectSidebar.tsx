import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceStartupRecovery } from "@/features/thread-startup/state/thread-startup-store";
import { ProjectDropWell } from "../ProjectDropWell";
import { useProjectTreeMenus } from "../ProjectTree";
import { useWorkspaceStore } from "../state/workspaceStore";
import { isProjectWorkspace } from "../state/project-workspaces";
import { CompletionUndoLine } from "./CompletionUndoLine";
import { ScopeBar } from "./ScopeBar";
import { SidebarList } from "./SidebarList";
import { useRowLifecycleStore } from "./row-lifecycle-store";
import { useSidebarUiStore, type SidebarScope, type SidebarView } from "./sidebar-ui-store";
import type { SidebarModel } from "./sidebar-model";
import { useSidebarModel } from "./use-sidebar-model";
import { useSidebarMotion } from "./sidebar-motion";

const VIEW_LABEL: Record<SidebarView, string> = { threads: "Threads", projects: "Projects" };
const VIEWS: readonly SidebarView[] = ["threads", "projects"];

function ViewMenu() {
  const view = useSidebarUiStore((s) => s.view);
  const setView = useSidebarUiStore((s) => s.setView);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="mr-auto flex h-8 min-w-0 items-center gap-1 rounded-control px-2 text-body-small font-medium text-ink transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus data-popup-open:bg-hover">
        {VIEW_LABEL[view]}
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {VIEWS.map((option) => (
          <DropdownMenuItem key={option} label={VIEW_LABEL[option]} checked={view === option} onClick={() => setView(option)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarListHeader({ scope, showScope }: { readonly scope: SidebarScope; readonly showScope: boolean }) {
  return (
    <div className="@container shrink-0">
      <div className="flex flex-wrap items-center gap-2 pt-3 pb-1">
        <ViewMenu />
        {showScope ? <ScopeBar scope={scope} className="basis-full @min-[220px]:shrink-0 @min-[220px]:basis-auto" /> : null}
      </div>
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

/** With no projects, the add-project well fills an empty Active list. In Closed it yields to the "No closed threads" line once any thread exists. */
function showDropWell(model: SidebarModel, hasProjects: boolean, hasThreads: boolean): boolean {
  if (hasProjects) return false;
  const listEmpty = model.items.every((item) => item.kind === "empty" || item.kind === "end-spacer");
  return listEmpty && (!hasThreads || model.scope === "active");
}

/**
 * The Projects sidebar: view and scope header, and the one virtual list of derived items, plus the
 * menus and dialogs its rows open.
 */
export function ProjectSidebar() {
  const { model, cause } = useSidebarModel();
  const selectedThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const shown = useSidebarMotion(model, cause, selectedThreadId);
  const { ctx, overlays } = useProjectTreeMenus();
  const hasProjects = useWorkspaceStore((s) => s.workspaces.some(isProjectWorkspace));
  const hasThreads = useWorkspaceStore((s) => s.threads.length > 0);
  const error = useWorkspaceStore((s) => s.error);
  useWorkspaceLoading();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
      <SidebarListHeader scope={model.scope} showScope={hasProjects || hasThreads} />
      <CompletionUndoLine onOpen={ctx.onSelectThread} flying={shown.flying} />
      <SidebarList
        items={shown.items}
        closing={shown.closing}
        arriving={shown.arriving}
        olderIds={model.olderIds}
        ctx={ctx}
        flip={cause === "push"}
        overlay={showDropWell(model, hasProjects, hasThreads) ? <div className="absolute inset-y-0 right-1.5 left-0"><ProjectDropWell /></div> : null}
      />
      {error && <p className="px-1.5 py-1 text-xs text-destructive">{error}</p>}
      {overlays}
    </div>
  );
}
