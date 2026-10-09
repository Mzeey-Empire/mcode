import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDiffStore } from "@/stores/diffStore";
import { usePlanStore } from "@/stores/planStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { hideRightPanelAdaptive, showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { Eye, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";

export type ComposerAccessMode = "supervised" | "automatic" | "full";

/** One option in the access-mode popover (generic or provider-native). */
export interface AccessModeOption {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

/** Props shared by Composer's compact and inline option controls. */
export interface ComposerOptionControlsProps {
  threadId?: string;
  accessMode: string;
  /** True when the provider requires Full access and cannot offer the supervised mode. */
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  onAccessModeChange: (next: ComposerAccessMode) => void;
}

const ACCESS_MODES: ReadonlyArray<AccessModeOption & { id: ComposerAccessMode }> = [
  { id: "supervised", label: "Manual", icon: Eye },
  { id: "automatic", label: "Auto", icon: ShieldCheck },
  { id: "full", label: "Full access", icon: KeyRound },
];

function isAccessModeDisabled(accessMode: ComposerAccessMode, permissionLocked: boolean): boolean {
  return permissionLocked && accessMode !== "full";
}

/** Why a locked provider dims every mode except Full access. */
const PERMISSION_LOCKED_REASON = "This provider only runs with Full access";

/** Compact access-mode menu; renders generic or provider-native options. */
export function AccessModeSelector({
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  modes,
  onAccessModeChange,
}: Omit<ComposerOptionControlsProps, "threadId" | "accessMode"> & {
  accessMode: string;
  modes?: readonly AccessModeOption[];
}) {
  const options = modes ?? ACCESS_MODES;
  const selected = options.find((mode) => mode.id === accessMode) ?? options[0];
  const Icon = selected.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="compact"
            aria-label={`Access mode: ${selected.label}`}
            className="gap-1.5 text-muted transition-colors hover:bg-hover/40 hover:text-ink"
          >
            <Icon size={14} />
            <span className="text-sm">{selected.label}</span>
          </Button>
        }
      />
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

function useComposerPlanPanel(threadId: string | undefined) {
  const hasPlans = usePlanStore(
    (state) =>
      Boolean(
        threadId &&
          ((state.plansByThread[threadId]?.length ?? 0) > 0 ||
            state.generatingThreads.has(threadId)),
      ),
  );
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const panelVisible = useDiffStore((state) =>
    activeWorkspaceId ? state.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const togglePlanPanel = () => {
    if (!threadId || !activeWorkspaceId) return;
    if (panelVisible) {
      hideRightPanelAdaptive(activeWorkspaceId, threadId);
      return;
    }
    showRightPanelAdaptive(activeWorkspaceId, threadId);
    useDiffStore.getState().setRightPanelTab(activeWorkspaceId, threadId, "tasks");
  };

  return { hasPlans, panelVisible, togglePlanPanel };
}

/** Renders the shared access selector and optional plan-panel control. */
export function ComposerOptionsMenu({
  threadId,
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  onAccessModeChange,
}: ComposerOptionControlsProps) {
  const { hasPlans, panelVisible, togglePlanPanel } = useComposerPlanPanel(threadId);

  return (
    <>
      <AccessModeSelector
        accessMode={accessMode}
        permissionLocked={permissionLocked}
        approvalReviewSupported={approvalReviewSupported}
        onAccessModeChange={onAccessModeChange}
      />
      {hasPlans && (
        <Button
          variant="ghost"
          size="compact"
          onClick={togglePlanPanel}
          aria-pressed={panelVisible}
          className={cn(
            "gap-1.5 transition-colors hover:bg-hover/40",
            panelVisible ? "text-primary hover:text-primary" : "text-muted hover:text-ink",
          )}
        >
          <ListChecks size={14} />
          <span className="text-sm">Plan</span>
        </Button>
      )}
    </>
  );
}

/** Inline Composer controls for wide layouts. */
export function InlineComposerOptions({
  threadId,
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  onAccessModeChange,
}: ComposerOptionControlsProps) {
  return <ComposerOptionsMenu
    threadId={threadId}
    accessMode={accessMode}
    permissionLocked={permissionLocked}
    approvalReviewSupported={approvalReviewSupported}
    onAccessModeChange={onAccessModeChange}
  />;
}
