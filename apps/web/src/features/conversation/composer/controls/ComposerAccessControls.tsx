import type { ComponentType } from "react";
import { Eye, KeyRound, Pencil, ShieldCheck } from "lucide-react";
import type { DevinMode } from "@mcode/contracts/models/enums";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { PermissionMode } from "@/transport";
import { PERMISSION_MODES } from "@/transport";
import { useThreadStore } from "@/stores/threadStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";

type ComposerAccessMode = "supervised" | "automatic" | "full";

/** One access option, generic or provider-native, as the access list shows it. */
export interface AccessOption {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ size?: number; className?: string }>;
  /** Why the option cannot be chosen; null when it can. */
  readonly disabledReason: string | null;
}

/** The current provider's access options, the selected one, and how to choose another. */
export interface ComposerAccessModel {
  readonly options: readonly AccessOption[];
  readonly selected: AccessOption;
  readonly choose: (id: string) => void;
}

/** What the access mapping needs from the composer. */
export interface ComposerAccessInput {
  readonly threadId?: string;
  readonly branchFromMessageId?: string;
  readonly selection: ComposerAgentSelection;
  /** True when the provider requires Full access and cannot offer the supervised mode. */
  readonly permissionLocked: boolean;
  readonly approvalReviewSupported: boolean;
  readonly onSelectionChange: (patch: Partial<ComposerAgentSelection>) => void;
  readonly onSelectionTouched: () => void;
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

type AccessModeEntry = { id: ComposerAccessMode; label: string; icon: AccessOption["icon"] };

const ASK_ME: AccessModeEntry = { id: "supervised", label: "Ask me", icon: Eye };

const ACCESS_MODES: readonly AccessModeEntry[] = [
  ASK_ME,
  { id: "automatic", label: "Approve for me", icon: ShieldCheck },
  { id: "full", label: "Don't ask", icon: KeyRound },
];

/** Why a locked provider dims every mode except Don't ask. */
const PERMISSION_LOCKED_REASON = "This provider runs without approval prompts";

/**
 * Devin's native session modes are its access modes: they decide how much
 * approval Devin asks for per action. `bypass` also maps to Mcode's coarse
 * `permissionMode: "full"`; every other mode stays `supervised`.
 */
const DEVIN_NORMAL: AccessOption & { id: DevinMode } = { id: "normal", label: "Normal", icon: Eye, disabledReason: null };

const DEVIN_ACCESS_MODES: ReadonlyArray<AccessOption & { id: DevinMode }> = [
  DEVIN_NORMAL,
  { id: "accept-edits", label: "Accept Edits", icon: Pencil, disabledReason: null },
  { id: "smart", label: "Smart", icon: ShieldCheck, disabledReason: null },
  { id: "bypass", label: "Bypass", icon: KeyRound, disabledReason: null },
];

function isDevinAccessMode(id: string): id is (typeof DEVIN_ACCESS_MODES)[number]["id"] {
  return DEVIN_ACCESS_MODES.some((mode) => mode.id === id);
}

function isComposerAccessMode(id: string): id is ComposerAccessMode {
  return ACCESS_MODES.some((mode) => mode.id === id);
}

function selectedOf(options: readonly AccessOption[], id: string, fallback: AccessOption): AccessOption {
  return options.find((option) => option.id === id) ?? options[0] ?? fallback;
}

function useDevinAccess(input: ComposerAccessInput): ComposerAccessModel {
  const { threadId, branchFromMessageId, selection, onSelectionChange, onSelectionTouched } = input;
  const devinMode = selection.devinMode && selection.devinMode !== "plan"
    ? selection.devinMode
    : selection.permissionMode === PERMISSION_MODES.FULL ? "bypass" : "normal";
  // The session's `mode` select gates account-restricted modes (e.g. bypass on
  // plans that forbid it); while unknown, fall back to the static list.
  const advertised = useProviderModelsStore((s) => s.modes.devin);
  const advertisedModes = advertised
    ? DEVIN_ACCESS_MODES.filter((mode) => advertised.includes(mode.id))
    : DEVIN_ACCESS_MODES;
  const options = advertisedModes.length > 0 ? advertisedModes : DEVIN_ACCESS_MODES;
  return {
    options,
    selected: selectedOf(options, devinMode, DEVIN_NORMAL),
    choose: (id) => {
      if (!isDevinAccessMode(id)) return;
      const permissionMode = id === "bypass" ? PERMISSION_MODES.FULL : PERMISSION_MODES.SUPERVISED;
      onSelectionChange({ devinMode: id, permissionMode });
      onSelectionTouched();
      persistDevinMode(threadId, branchFromMessageId, id);
      persistPermissionMode(threadId, permissionMode);
    },
  };
}

function permissionAccess(input: ComposerAccessInput): ComposerAccessModel {
  const { threadId, selection, permissionLocked, approvalReviewSupported, onSelectionChange, onSelectionTouched } = input;
  const accessMode: ComposerAccessMode = selection.permissionMode === PERMISSION_MODES.FULL
    ? "full"
    : selection.approvalReviewMode === "automatic" && approvalReviewSupported
      ? "automatic"
      : "supervised";
  const options = ACCESS_MODES
    .filter((mode) => approvalReviewSupported || mode.id !== "automatic")
    .map((mode) => ({
      ...mode,
      disabledReason: permissionLocked && mode.id !== "full" ? PERMISSION_LOCKED_REASON : null,
    }));
  return {
    options,
    selected: selectedOf(options, accessMode, { ...ASK_ME, disabledReason: null }),
    choose: (id) => {
      if (!isComposerAccessMode(id)) return;
      if (permissionLocked && id !== "full") return;
      if (id === "automatic" && !approvalReviewSupported) return;
      const permissionMode = id === "full" ? PERMISSION_MODES.FULL : PERMISSION_MODES.SUPERVISED;
      const approvalReviewMode = id === "automatic" ? "automatic" : "manual";
      onSelectionChange({ permissionMode, approvalReviewMode });
      onSelectionTouched();
      persistPermissionMode(threadId, permissionMode);
    },
  };
}

/**
 * Maps the current provider's access onto options: Ask me, Approve for me (only with approval review) and Don't
 * ask, or Devin's native modes. A provider that requires Full access dims the others with the reason.
 */
export function useComposerAccess(input: ComposerAccessInput): ComposerAccessModel {
  const devin = useDevinAccess(input);
  return input.selection.provider === "devin" ? devin : permissionAccess(input);
}
