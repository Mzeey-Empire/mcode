import { create } from "zustand";
import type { ProviderAvailability, ProviderId } from "@mcode/contracts";

/** Zustand state shape for the provider availability store. */
interface State {
  providers: ProviderAvailability[];
  /** Replace the full provider list with a new snapshot from the server. */
  replace: (list: ProviderAvailability[]) => void;
  /** Return the full availability record for a provider, or undefined if not in the list. */
  getAvailability: (id: ProviderId) => ProviderAvailability | undefined;
  /** Return true when the provider is marked enabled in settings. */
  isEnabled: (id: ProviderId) => boolean;
  /**
   * Return true when the provider is safe to use for a new thread.
   *
   * Requires: enabled, hasAdapter, and cli.status !== "not_found".
   * "unchecked" is treated as usable to avoid false alarms during startup
   * before the server has had a chance to verify the CLI.
   */
  isUsable: (id: ProviderId) => boolean;
}

/** Mirrors the server's ProviderAvailability[] list. Populated on WS connect, replaced on push. */
export const useProviderAvailabilityStore = create<State>((set, get) => ({
  providers: [],
  replace: (list) => set({ providers: list }),
  getAvailability: (id) => get().providers.find((p) => p.id === id),
  isEnabled: (id) => get().providers.find((p) => p.id === id)?.enabled ?? false,
  isUsable: (id) => {
    const row = get().providers.find((p) => p.id === id);
    if (!row) return false;
    if (!row.enabled) return false;
    if (!row.hasAdapter) return false;
    // "unchecked" means the server hasn't verified the CLI yet; don't block the user.
    if (row.cli.status === "not_found") return false;
    return true;
  },
}));
