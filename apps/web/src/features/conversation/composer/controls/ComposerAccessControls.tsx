import { Eye, KeyRound, Pencil, ShieldCheck } from "lucide-react";
import {
  AccessModeMenu,
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
import { useProviderModelsStore } from "@/stores/providerModelsStore";

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

function persistPermissionMode(threadId: string | undefined, permissionMode: PermissionMode): void {
  if (!threadId) return;
  void useThreadStore.getState().setThreadSettings(threadId, { permissionMode });
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
  { id: "normal", label: "Normal", icon: Eye },
  { id: "accept-edits", label: "Accept Edits", icon: Pencil },
  { id: "smart", label: "Smart", icon: ShieldCheck },
  { id: "bypass", label: "Bypass", icon: KeyRound },
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
  // The session's `mode` select gates account-restricted modes (e.g. bypass on
  // plans that forbid it); while unknown, fall back to the static list.
  const advertised = useProviderModelsStore((s) => s.modes.devin);
  const advertisedModes = advertised
    ? DEVIN_ACCESS_MODES.filter((mode) => advertised.includes(mode.id))
    : DEVIN_ACCESS_MODES;
  const modes = advertisedModes.length > 0 ? advertisedModes : DEVIN_ACCESS_MODES;
  return (
    <AccessModeMenu
      accessMode={devinMode}
      permissionLocked={false}
      approvalReviewSupported={false}
      modes={modes}
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

/** Renders the permission control for the current provider. */
export function ComposerAccessControls(props: ComposerAccessControlsProps) {
  if (props.selection.provider === "devin") {
    return <DevinAccessControls {...props} />;
  }
  return <ComposerPermissionControls {...props} />;
}
