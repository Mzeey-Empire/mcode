import type { ProviderId } from "@mcode/contracts";

/** Props for the dialog shown when disabling a provider that is set as default. */
export interface ConfirmDisableDialogProps {
  /** The provider the user is attempting to disable. */
  providerId: ProviderId;
  /** Called when the user cancels the dialog. */
  onCancel: () => void;
  /** Called when the user confirms disabling the provider. */
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirmation dialog shown before disabling a provider that is currently
 * referenced by other settings (e.g. the default model provider).
 * Full implementation is in Task 20. Renders nothing for now.
 */
export function ConfirmDisableDialog(_props: ConfirmDisableDialogProps) {
  return null;
}
