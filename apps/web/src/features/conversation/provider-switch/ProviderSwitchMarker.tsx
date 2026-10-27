import type { ProviderSwitchMarker as ProviderSwitch } from "@mcode/contracts/models/message";
import { ProviderIcon, providerLabel } from "@/components/ui/provider-icon";

/** Timeline marker for a send that moved the thread to another provider. */
export function ProviderSwitchMarker({ providerSwitch }: { readonly providerSwitch: ProviderSwitch }) {
  const from = providerLabel(providerSwitch.fromProvider);
  const to = providerLabel(providerSwitch.toProvider);
  return (
    <div className="flex items-center gap-3 py-2" role="note" aria-label={`Switched from ${from} to ${to}`} data-provider-switch={providerSwitch.handoffId}>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted">
        <ProviderIcon provider={providerSwitch.fromProvider} size={12} />
        <span>{from}</span>
        <span aria-hidden="true">→</span>
        <ProviderIcon provider={providerSwitch.toProvider} size={12} />
        <span className="font-medium text-ink">{to}</span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
