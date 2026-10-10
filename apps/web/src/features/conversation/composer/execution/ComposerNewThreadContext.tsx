import { useMemo } from "react";
import { ModeSelector, ALL_MODE_OPTIONS, type ComposerMode, type ModeOption } from "@/components/chat/ModeSelector";
import { ProjectChooser } from "@/features/projects/ProjectChooser";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { Folder, FolderOpen, X } from "lucide-react";
import { ComposerTargetSelection } from "./ComposerTargetSelection";

const CONTEXT_CONTROL_CLASS =
  "h-[28px] gap-[6px] rounded-md px-[10px] text-xs font-medium leading-none";

/** Props for the new-thread project and execution-target strip. */
export interface ComposerNewThreadContextProps {
  workspaceId: string | undefined;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
}

/** Renders project, mode, and execution-target controls for a new thread. */
export function ComposerNewThreadContext({
  workspaceId,
  mode,
  onModeChange,
}: ComposerNewThreadContextProps) {
  const activeWorkspace = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId),
  );
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const isGitRepo = activeWorkspace?.is_git_repo ?? false;
  const modeOptions = useMemo<ModeOption[]>(
    () => isGitRepo ? ALL_MODE_OPTIONS : ALL_MODE_OPTIONS.filter((option) => option.value === "direct"),
    [isGitRepo],
  );

  return (
    <div
      data-testid="new-thread-context-strip"
      className="relative z-(--layer-base) mx-[14px] flex h-[40px] min-w-0 items-center gap-1 overflow-x-auto rounded-t-xl bg-hover/45 px-[16px] ring-1 ring-inset ring-border/60"
    >
      {activeWorkspace ? (
        <>
          <div className="inline-flex h-[28px] min-w-0 shrink items-center gap-[6px] rounded-md pl-[10px] text-xs font-medium leading-none text-ink/90">
            <Folder size={14} className="shrink-0 text-muted" aria-hidden />
            <Tooltip>
              <TooltipTrigger
                render={<span className="max-w-40 text-fade">{activeWorkspace.name}</span>}
              />
              <TooltipContent>{activeWorkspace.path}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-compact"
                    aria-label={`Clear ${activeWorkspace.name} project`}
                    onClick={() => setActiveWorkspace(null)}
                    className="-mr-0.5 size-7 rounded-md text-muted transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:ring-destructive/20"
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                }
              />
              <TooltipContent>Clear project</TooltipContent>
            </Tooltip>
          </div>
          {isGitRepo ? (
            <ModeSelector
              mode={mode}
              onModeChange={onModeChange}
              locked={false}
              options={modeOptions}
              className={CONTEXT_CONTROL_CLASS}
              iconSize={14}
            />
          ) : (
            <span
              data-testid="local-environment-label"
              className="flex h-[28px] items-center gap-[6px] rounded-md px-[10px] text-xs font-medium leading-none text-muted/70"
            >
              <FolderOpen size={14} aria-hidden />
              Local
            </span>
          )}
          {isGitRepo && (
            <ComposerTargetSelection scope="new-thread" mode={mode} workspaceId={workspaceId} />
          )}
        </>
      ) : (
        <ProjectChooser
          side="top"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="compact"
              data-testid="new-thread-project-picker"
              className={`${CONTEXT_CONTROL_CLASS} text-ink/90 hover:bg-selected/70`}
            >
              <Folder size={14} className="size-3.5 text-muted" aria-hidden />
              Choose project
            </Button>
          }
        />
      )}
    </div>
  );
}
