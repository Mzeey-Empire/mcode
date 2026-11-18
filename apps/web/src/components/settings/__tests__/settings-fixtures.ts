import { SettingsSchema, type Settings } from "@mcode/contracts/models/settings";
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

function mergePlain(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = mergePlain(out[key], value);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Settings with `patch` deep-merged over `base`, validated as the server would return them. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  return SettingsSchema().parse(mergePlain(base, patch));
}
