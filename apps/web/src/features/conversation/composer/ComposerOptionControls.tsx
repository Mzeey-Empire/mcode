import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, KeyRound, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";

export type ComposerAccessMode = "supervised" | "automatic" | "full";

/** One option in the access-mode popover (generic or provider-native). */
export interface AccessModeOption {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

/** Props for Composer's access-mode control. */
export interface ComposerOptionControlsProps {
  accessMode: string;
  /** True when the provider requires Full access and cannot offer the supervised mode. */
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  onAccessModeChange: (next: ComposerAccessMode) => void;
}

const ACCESS_MODES: ReadonlyArray<AccessModeOption & { id: ComposerAccessMode }> = [
  { id: "supervised", label: "Ask me", icon: Eye },
  { id: "automatic", label: "Approve for me", icon: ShieldCheck },
  { id: "full", label: "Don't ask", icon: KeyRound },
];

function isAccessModeDisabled(accessMode: ComposerAccessMode, permissionLocked: boolean): boolean {
  return permissionLocked && accessMode !== "full";
}

/** Why a locked provider dims every mode except Don't ask. */
const PERMISSION_LOCKED_REASON = "This provider runs without approval prompts";

/**
 * Compact access-mode menu; renders generic or provider-native options. The
 * trigger drops its label below 560px of the nearest `@container` ancestor.
 */
export function AccessModeMenu({
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  modes,
  onAccessModeChange,
}: Omit<ComposerOptionControlsProps, "accessMode"> & {
  accessMode: string;
  modes?: readonly AccessModeOption[];
}) {
  const options = modes ?? ACCESS_MODES;
  const selected = options.find((mode) => mode.id === accessMode) ?? options[0];
  const Icon = selected.icon;

  return (
    <DropdownMenu>
      {/* A narrow Composer hides the label, so the tooltip names the mode for the icon alone. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="compact"
                  aria-label={`Access mode: ${selected.label}`}
                  className="gap-1.5 text-muted transition-colors hover:bg-hover/40 hover:text-ink"
                >
                  <Icon size={14} />
                  <span className="text-sm @max-[560px]:hidden">{selected.label}</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent side="top">{`Access mode: ${selected.label}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={8} className="w-60">
        {options.filter((mode) => modes != null || approvalReviewSupported || mode.id !== "automatic").map((mode) => {
          const ModeIcon = mode.icon;
          const disabled = modes == null && isAccessModeDisabled(mode.id as ComposerAccessMode, permissionLocked);
          return (
            <DropdownMenuItem
              key={mode.id}
              label={mode.label}
              icon={<ModeIcon />}
              checked={accessMode === mode.id}
              disabledReason={disabled ? PERMISSION_LOCKED_REASON : null}
              onClick={() => onAccessModeChange(mode.id as ComposerAccessMode)}
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
