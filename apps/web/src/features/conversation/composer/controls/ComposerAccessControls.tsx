import { Eye, KeyRound, Lock, Pencil, ShieldCheck, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopilotAgentSelector } from "@/components/chat/CopilotAgentSelector";
import {
  AccessModeSelector,
  InlineComposerOptions,
  ComposerOptionsMenu,
  type AccessModeOption,
  type ComposerAccessMode,
} from "../ComposerOptionControls";
import type { DevinMode } from "@mcode/contracts";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { PermissionMode } from "@/transport";
import { PERMISSION_MODES } from "@/transport";
import { useThreadStore } from "@/stores/threadStore";

/** Props for Composer's provider-specific access controls. */
export interface ComposerAccessControlsProps {
  threadId?: string;
  workspaceId?: string;
  branchFromMessageId?: string;
  selection: ComposerAgentSelection;
  isModelLocked: boolean;
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  showInlineOptions: boolean;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
  onSelectionTouched(): void;
}

function nextPermissionMode(permissionMode: PermissionMode): PermissionMode {
  return permissionMode === PERMISSION_MODES.FULL
    ? PERMISSION_MODES.SUPERVISED
    : PERMISSION_MODES.FULL;
}

function persistPermissionMode(threadId: string | undefined, permissionMode: PermissionMode): void {
  if (!threadId) return;
  void useThreadStore.getState().setThreadSettings(threadId, { permissionMode });
}

function persistCopilotAgent(
  threadId: string | undefined,
  branchFromMessageId: string | undefined,
  copilotAgent: ComposerAgentSelection["copilotAgent"],
): void {
  if (!threadId || branchFromMessageId) return;
  void useThreadStore.getState().setThreadSettings(threadId, { copilotAgent });
}

function persistDevinMode(
  threadId: string | undefined,
  branchFromMessageId: string | undefined,
  devinMode: ComposerAgentSelection["devinMode"],
): void {
  if (!threadId || branchFromMessageId) return;
  void useThreadStore.getState().setThreadSettings(threadId, { devinMode });
}

/**
 * Devin's native session modes are its access modes: they decide how much
 * approval Devin asks for per action. `bypass` also maps to Mcode's coarse
 * `permissionMode: "full"`; every other mode stays `supervised`.
 */
const DEVIN_ACCESS_MODES: ReadonlyArray<AccessModeOption & { id: DevinMode }> = [
  { id: "normal", label: "Normal", description: "Devin asks before each action that needs approval.", icon: Eye },
  { id: "accept-edits", label: "Accept Edits", description: "Auto-accepts file edits; still prompts for other actions.", icon: Pencil },
  { id: "smart", label: "Smart", description: "Devin decides which actions are safe to run automatically.", icon: ShieldCheck },
  { id: "bypass", label: "Bypass", description: "Runs without permission prompts.", icon: KeyRound },
];

function DevinAccessControls({
  threadId,
  branchFromMessageId,
  selection,
  onSelectionChange,
  onSelectionTouched,
}: Omit<
  ComposerAccessControlsProps,
  "workspaceId" | "permissionLocked" | "approvalReviewSupported" | "showInlineOptions" | "isModelLocked"
>) {
  const devinMode = selection.devinMode && selection.devinMode !== "plan"
    ? selection.devinMode
    : selection.permissionMode === PERMISSION_MODES.FULL ? "bypass" : "normal";
  return (
    <AccessModeSelector
      accessMode={devinMode}
      permissionLocked={false}
      approvalReviewSupported={false}
      modes={DEVIN_ACCESS_MODES}
      onAccessModeChange={(next) => {
        const mode = next as DevinMode;
        const permissionMode = mode === "bypass" ? PERMISSION_MODES.FULL : PERMISSION_MODES.SUPERVISED;
        onSelectionChange({ devinMode: mode, permissionMode });
        onSelectionTouched();
        persistDevinMode(threadId, branchFromMessageId, mode);
        persistPermissionMode(threadId, permissionMode);
      }}
    />
  );
}

function CopilotAccessControls({
  threadId,
  workspaceId,
  branchFromMessageId,
  selection,
  isModelLocked,
  onSelectionChange,
  onSelectionTouched,
}: Omit<ComposerAccessControlsProps, "permissionLocked" | "showInlineOptions">) {
  const permissionMode = selection.permissionMode;
  const permissionLabel = permissionMode === PERMISSION_MODES.FULL ? "Full access" : "Manual";
  const permissionTooltip = permissionMode === PERMISSION_MODES.FULL ? "Full access mode" : "Manual mode";

  return (
    <>
      <CopilotAgentSelector
        selected={selection.copilotAgent}
        workspaceId={workspaceId ?? ""}
        disabled={isModelLocked}
        onChange={(copilotAgent) => {
          onSelectionChange({ copilotAgent });
          persistCopilotAgent(threadId, branchFromMessageId, copilotAgent);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const nextMode = nextPermissionMode(permissionMode);
                onSelectionChange({ permissionMode: nextMode });
                onSelectionTouched();
                persistPermissionMode(threadId, nextMode);
              }}
              className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              {permissionMode === PERMISSION_MODES.FULL ? <Unlock size={14} /> : <Lock size={14} />}
              <span className="text-sm">{permissionLabel}</span>
            </Button>
          }
        />
        <TooltipContent>{permissionTooltip}</TooltipContent>
      </Tooltip>
    </>
  );
}

function ComposerPermissionControls({
  threadId,
  selection,
  permissionLocked,
  showInlineOptions,
  approvalReviewSupported,
  onSelectionChange,
  onSelectionTouched,
}: Pick<
  ComposerAccessControlsProps,
  | "threadId"
  | "selection"
  | "permissionLocked"
  | "showInlineOptions"
  | "approvalReviewSupported"
  | "onSelectionChange"
  | "onSelectionTouched"
>) {
  const accessMode: ComposerAccessMode = selection.permissionMode === PERMISSION_MODES.FULL
    ? "full"
    : selection.approvalReviewMode === "automatic" && approvalReviewSupported
      ? "automatic"
      : "supervised";
  const updateAccessMode = (next: ComposerAccessMode) => {
    if (permissionLocked && next !== "full") return;
    if (next === "automatic" && !approvalReviewSupported) return;
    const permissionMode = next === "full" ? PERMISSION_MODES.FULL : PERMISSION_MODES.SUPERVISED;
    const approvalReviewMode = next === "automatic" ? "automatic" : "manual";
    onSelectionChange({ permissionMode, approvalReviewMode });
    onSelectionTouched();
    persistPermissionMode(threadId, permissionMode);
  };

  if (showInlineOptions) {
    return <InlineComposerOptions
      threadId={threadId}
      accessMode={accessMode}
      permissionLocked={permissionLocked}
      approvalReviewSupported={approvalReviewSupported}
      onAccessModeChange={updateAccessMode}
    />;
  }

  return <ComposerOptionsMenu
    threadId={threadId}
    accessMode={accessMode}
    permissionLocked={permissionLocked}
    approvalReviewSupported={approvalReviewSupported}
    onAccessModeChange={updateAccessMode}
  />;
}

/** Renders Copilot selection and the permission control for the current provider. */
export function ComposerAccessControls(props: ComposerAccessControlsProps) {
  if (props.selection.provider === "copilot") {
    return <CopilotAccessControls {...props} />;
  }
  if (props.selection.provider === "devin") {
    return <DevinAccessControls {...props} />;
  }
  return <ComposerPermissionControls {...props} />;
}
