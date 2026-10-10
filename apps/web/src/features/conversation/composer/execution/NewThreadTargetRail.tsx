import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { basename } from "@/lib/path";
import type { OverviewPresentation } from "@/stores/overviewStore";
import { ComposerTargetSelection } from "./ComposerTargetSelection";
import type { ComposerMode } from "./composer-mode";
import { WorkspaceTargetMenu } from "./WorkspaceTargetMenu";

/**
 * The rail carries the workspace and branch only while the overview card is hidden;
 * a docked or overlaid card shows the same choices, so a second copy would compete with it.
 */
export function isNewThreadTargetRailVisible(presentation: OverviewPresentation): boolean {
  return presentation === "hidden";
}

/** Props for {@link NewThreadTargetRail}. */
export interface NewThreadTargetRailProps {
  readonly workspaceId: string | undefined;
  readonly mode: ComposerMode;
  readonly overviewPresentation: OverviewPresentation;
  readonly onModeChange: (mode: ComposerMode) => void;
}

/**
 * The tab above a new thread's composer that picks where it runs (`2AXW-2`): the workspace menu,
 * then the branch or worktree trigger. The project itself is chosen in the heading, so without one
 * the rail has nothing to offer and renders nothing.
 */
export function NewThreadTargetRail({ workspaceId, mode, overviewPresentation, onModeChange }: NewThreadTargetRailProps) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId));
  if (!workspace || !isNewThreadTargetRailVisible(overviewPresentation)) return null;

  const isGitRepo = workspace.is_git_repo;
  return (
    <div
      data-testid="new-thread-target-rail"
      className="mx-[1.4rem] flex min-w-0 items-center gap-1 overflow-x-auto rounded-t-xl border border-b-0 border-border bg-background px-2 py-1.5"
    >
      <WorkspaceTargetMenu mode={mode} isGitRepo={isGitRepo} folder={basename(workspace.path)} onModeChange={onModeChange} />
      {isGitRepo ? <ComposerTargetSelection scope="new-thread" mode={mode} workspaceId={workspace.id} /> : null}
    </div>
  );
}
