import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { basename } from "@/lib/path";
import { cn } from "@/lib/utils";
import { TRAY_SURFACE_CLASS } from "../ComposerTray";
import { ComposerTargetSelection } from "./ComposerTargetSelection";
import type { ComposerMode } from "./composer-mode";
import { WorkspaceTargetMenu } from "./WorkspaceTargetMenu";

/** Props for {@link NewThreadTargetRail}. */
export interface NewThreadTargetRailProps {
  readonly workspaceId: string | undefined;
  readonly mode: ComposerMode;
  readonly onModeChange: (mode: ComposerMode) => void;
  /** True while the slash menu covers the tab; its controls are then hidden and inert, as the tray's are. */
  readonly covered?: boolean;
}

/**
 * The tab above a new thread's composer that picks where it runs (`2AXW-2`): the workspace menu,
 * then the branch or worktree trigger. The project itself is chosen in the heading, so without one
 * the rail has nothing to offer and renders nothing. It has the tray's look, so with files attached
 * the tab and the tray below it read as one panel.
 */
export function NewThreadTargetRail({ workspaceId, mode, onModeChange, covered = false }: NewThreadTargetRailProps) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId));
  if (!workspace) return null;

  const isGitRepo = workspace.is_git_repo;
  return (
    <div
      data-testid="new-thread-target-rail"
      data-tray-tab=""
      inert={covered}
      className={cn(TRAY_SURFACE_CLASS, "flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-0.5", covered && "*:invisible")}
    >
      <WorkspaceTargetMenu mode={mode} isGitRepo={isGitRepo} folder={basename(workspace.path)} onModeChange={onModeChange} />
      {isGitRepo ? (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <ComposerTargetSelection scope="new-thread" mode={mode} workspaceId={workspace.id} />
        </div>
      ) : null}
    </div>
  );
}
