import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { PROVIDER_CATALOG } from "@mcode/contracts";
import type { PartialSettings, ProviderId, SettingsProviderId } from "@mcode/contracts";

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
 * Confirms disabling a provider currently used as a default (model and/or utility model).
 * On confirm, performs a single settings.update that flips the toggle AND rewrites
 * the affected defaults to the deterministic replacement, keeping the settings
 * consistent in one atomic RPC call.
 */
export function ConfirmDisableDialog({
  providerId,
  onCancel,
  onConfirm,
}: ConfirmDisableDialogProps) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const providers = useProviderAvailabilityStore((s) => s.providers);

  const disablingName = PROVIDER_CATALOG.find((e) => e.id === providerId)?.name ?? providerId;
  const replacement = pickReplacement(providerId, providers);
  const replacementName = PROVIDER_CATALOG.find((e) => e.id === replacement)?.name ?? replacement;

  const affectedModel = settings.model.defaults.provider === providerId;
  // utility provider defaults to "" (inherit), so only flag it when explicitly set.
  const affectedUtility =
    settings.model.utility.provider !== "" && settings.model.utility.provider === providerId;

  // Default case is only for new threads; utility-only uses a different phrasing.
  const scope =
    affectedModel && affectedUtility
      ? "your default provider for new threads and utility tasks"
      : affectedModel
        ? "your default provider for new threads"
        : "your utility model provider";
  const description = `${disablingName} is currently ${scope}. Disabling it will switch your default to ${replacementName}.`;

  async function handleConfirm() {
    // Batch the toggle-off and default rewrite into a single update call so the
    // server applies both atomically rather than leaving a transient inconsistent state.
    // Cast through unknown because PartialSettings.provider.enabled expects named keys
    // (e.g. `{ codex?: boolean }`), but we build the key dynamically at runtime.
    // The cast is safe: providerId is always a valid key of that object.
    const enabledPatch = { [providerId]: false } as unknown as NonNullable<
      NonNullable<PartialSettings["provider"]>["enabled"]
    >;
    const patch: PartialSettings = {
      provider: { enabled: enabledPatch },
    };
    if (affectedModel) {
      patch.model = { defaults: { provider: replacement as SettingsProviderId } };
    }
    if (affectedUtility) {
      patch.model = { ...patch.model, utility: { provider: replacement as SettingsProviderId } };
    }
    await update(patch);
    await onConfirm();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable {disablingName}?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Disable and switch default</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Picks the best replacement provider when `disabling` is turned off.
 * Iterates PROVIDER_CATALOG order (canonical) and returns the first provider that
 * is enabled, has an adapter, and whose CLI is not known-missing — so we don't
 * rewrite the default to a provider that cannot actually be used.
 * Falls back to "claude" if no other usable provider is found.
 */
function pickReplacement(
  disabling: ProviderId,
  providers: ReturnType<typeof useProviderAvailabilityStore.getState>["providers"],
): ProviderId {
  for (const entry of PROVIDER_CATALOG) {
    if (entry.id === disabling) continue;
    const row = providers.find((p) => p.id === entry.id);
    if (row?.enabled && row.hasAdapter && row.cli.status !== "not_found") {
      return entry.id;
    }
  }
  return "claude";
}
