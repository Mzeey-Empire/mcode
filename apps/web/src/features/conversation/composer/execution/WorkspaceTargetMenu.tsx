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

/** Props for {@link WorkspaceTargetMenu}. */
export interface WorkspaceTargetMenuProps {
  readonly mode: ComposerMode;
  readonly isGitRepo: boolean;
  /** The project folder's name, shown in mono beside Local. */
  readonly folder: string;
  readonly onModeChange: (mode: ComposerMode) => void;
  readonly className?: string;
}

/**
 * The workspace trigger and its names-only "Workspace" menu (`20LL-2`). Choosing a row only switches
 * the mode; the branch trigger beside it then picks the branch or worktree. A project that is not a
 * git repo can only run Local, so it gets a static label instead of a menu.
 */
export function WorkspaceTargetMenu({ mode, isGitRepo, folder, onModeChange, className }: WorkspaceTargetMenuProps) {
  if (!isGitRepo) {
    const { Icon, label } = COMPOSER_MODE_OPTIONS.direct;
    return (
      <span data-testid="workspace-target-trigger" className={cn(TARGET_TRIGGER_CLASS, "inline-flex h-8 items-center", className)}>
        <Icon className="size-4" />
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
            <Icon className="size-4" />
            <span>{label}</span>
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-[28.8rem]">
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>Workspace</DropdownMenuGroupLabel>
          {composerModeOptions(true).map((option) => (
            <DropdownMenuItem
              key={option.mode}
              label={option.label}
              icon={<option.Icon />}
              checked={option.mode === mode}
              trailing={option.mode === "direct" ? <span className="font-code text-caption text-muted">{folder}</span> : undefined}
              onClick={() => onModeChange(option.mode)}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
