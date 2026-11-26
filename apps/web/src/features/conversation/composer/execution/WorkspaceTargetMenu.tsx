import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { COMPOSER_MODE_OPTIONS, composerModeOptions, type ComposerMode } from "./composer-mode";
import { TARGET_TRIGGER_CLASS } from "./target-trigger";

/** Why a workspace mode cannot be chosen right now, as the row's trailing status and its tooltip. */
export interface UnavailableMode {
  readonly status: string;
  readonly reason: string;
}

/** Props for {@link WorkspaceTargetMenu}. */
export interface WorkspaceTargetMenuProps {
  readonly mode: ComposerMode;
  readonly isGitRepo: boolean;
  /** The project folder's name, shown in mono beside Local. */
  readonly folder: string;
  readonly onModeChange: (mode: ComposerMode) => void;
  /** Limits the menu to these modes, for a host that cannot offer a worktree. Defaults to every mode. */
  readonly modes?: readonly ComposerMode[];
  /** Dims these modes' rows and says why, such as Existing worktree in a project with no worktrees. */
  readonly unavailable?: Readonly<Partial<Record<ComposerMode, UnavailableMode>>>;
  readonly className?: string;
}

/**
 * The workspace trigger and its names-only "Workspace" menu (`20LL-2`). Choosing a row only switches
 * the mode; the branch trigger beside it then picks the branch or worktree. A project that is not a
 * git repo can only run Local, so it gets a static label instead of a menu.
 */
export function WorkspaceTargetMenu({ mode, isGitRepo, folder, onModeChange, modes, unavailable, className }: WorkspaceTargetMenuProps) {
  if (!isGitRepo) {
    const { Icon, label } = COMPOSER_MODE_OPTIONS.direct;
    return (
      <span data-testid="workspace-target-trigger" className={cn(TARGET_TRIGGER_CLASS, "inline-flex items-center", className)}>
        <Icon className="size-3.5" />
        {label}
      </span>
    );
  }

  const { Icon, label } = COMPOSER_MODE_OPTIONS[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="workspace-target-trigger"
            className={cn(TARGET_TRIGGER_CLASS, "min-w-[15.2rem] justify-start", className)}
          >
            <Icon className="size-3.5" />
            <span>{label}</span>
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start" side="top" className="w-[28.8rem]">
        <WorkspaceModeMenuGroup mode={mode} folder={folder} onModeChange={onModeChange} modes={modes} unavailable={unavailable} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Props for {@link WorkspaceModeMenuGroup}. */
export type WorkspaceModeMenuGroupProps = Pick<WorkspaceTargetMenuProps, "mode" | "folder" | "onModeChange" | "modes" | "unavailable">;

/**
 * The "Workspace" menu rows for a git project, shared by the rail trigger and the Overview row so
 * both list the same names, order and folder meta. Render inside a `DropdownMenuContent`.
 */
export function WorkspaceModeMenuGroup({ mode, folder, onModeChange, modes, unavailable }: WorkspaceModeMenuGroupProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuGroupLabel>Workspace</DropdownMenuGroupLabel>
      {composerModeOptions(true).filter((option) => modes === undefined || modes.includes(option.mode)).map((option) => (
        <DropdownMenuItem
          key={option.mode}
          label={option.label}
          icon={<option.Icon />}
          checked={option.mode === mode}
          trailing={rowTrailing(option.mode, folder, unavailable?.[option.mode])}
          disabledReason={unavailable?.[option.mode]?.reason}
          onClick={() => onModeChange(option.mode)}
        />
      ))}
    </DropdownMenuGroup>
  );
}

function rowTrailing(mode: ComposerMode, folder: string, unavailable: UnavailableMode | undefined) {
  if (unavailable) return <span className="text-caption text-muted">{unavailable.status}</span>;
  return mode === "direct" ? <FolderMeta folder={folder} /> : undefined;
}

// The row's trailing slot never shrinks, so an unbounded folder name would squeeze out "Local" and the check.
function FolderMeta({ folder }: { folder: string }) {
  return <span className="block max-w-[12rem] text-fade font-code text-caption text-muted">{folder}</span>;
}
