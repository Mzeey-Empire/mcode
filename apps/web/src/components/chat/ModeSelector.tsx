import { FolderOpen, GitBranch, GitFork, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * How the user wants to run the next thread.
 * - "direct": run in the workspace directory
 * - "worktree": create a new git worktree
 * - "existing-worktree": attach to an already-created worktree
 */
export type ComposerMode = "direct" | "worktree" | "existing-worktree";

/** Configuration for a single mode option in the dropdown. */
export interface ModeOption {
  value: ComposerMode;
  label: string;
  icon: typeof FolderOpen;
}

/** All available mode options. Consumers can filter this list before passing to ModeSelector. */
export const ALL_MODE_OPTIONS: ModeOption[] = [
  { value: "direct", label: "Local", icon: FolderOpen },
  { value: "worktree", label: "New worktree", icon: GitBranch },
  { value: "existing-worktree", label: "Existing worktree", icon: GitFork },
];

interface ModeSelectorProps {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  locked: boolean;
  /** Subset of modes to show. Defaults to ALL_MODE_OPTIONS. */
  options?: ModeOption[];
}

/** Dropdown for choosing how a new thread runs (local, new worktree, existing worktree). */
export function ModeSelector({ mode, onModeChange, locked, options = ALL_MODE_OPTIONS }: ModeSelectorProps) {
  if (options.length === 0) {
    return null;
  }

  const selected = options.find((o) => o.value === mode) ?? options[0];
  const Icon = selected.icon;

  if (locked) {
    const lockedLabel =
      mode === "worktree" || mode === "existing-worktree" ? "Worktree" : "Local";
    return (
      <span className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground/70">
        <Icon size={11} />
        {lockedLabel}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon size={12} />
        {selected.label}
        <ChevronDown size={10} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[160px]">
        {options.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onModeChange(option.value)}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs",
                option.value === mode
                  ? "bg-accent text-foreground"
                  : "text-popover-foreground",
              )}
            >
              <OptionIcon size={12} />
              <span className="flex-1 text-left">{option.label}</span>
              {option.value === mode && <Check size={10} className="text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
