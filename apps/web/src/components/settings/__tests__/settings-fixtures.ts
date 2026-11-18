import { PROVIDER_CATALOG } from "@mcode/contracts/providers/catalog";
import type { ProviderAvailability } from "@mcode/contracts/providers/availability";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";

/** Seeds provider availability from the catalog: every available provider enabled with its CLI found, unless overridden. */
export function seedProviderAvailability(overrides: Partial<Record<string, Partial<ProviderAvailability>>> = {}): void {
  useProviderAvailabilityStore.setState({
    providers: PROVIDER_CATALOG.map((entry): ProviderAvailability => ({
      id: entry.id,
      enabled: !entry.comingSoon,
      hasAdapter: !entry.comingSoon,
      beta: entry.beta,
      comingSoon: entry.comingSoon,
      capabilities: [],
      cli: { status: "found", resolvedPath: `/bin/${entry.cliBinary}`, configuredPath: "" },
      ...overrides[entry.id],
    })),
  });
}
