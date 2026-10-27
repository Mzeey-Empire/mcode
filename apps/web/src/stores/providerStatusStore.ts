import { create } from "zustand";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { ProviderStatus } from "@mcode/contracts/providers/provider-status";
import { getTransport } from "@/transport";

/** Zustand state shape for the provider status store. */
interface State {
  /** One status per enabled provider, as last reported by the server. */
  statuses: ProviderStatus[];
  /** Loads every status over RPC; `force` asks the server to re-check instead of serving its cache. */
  fetch: (force?: boolean) => Promise<void>;
  /** Replaces one provider's status from a `providers.statusChanged` push. */
  apply: (status: ProviderStatus) => void;
  /**
   * Updates a provider's CLI. Progress and failure arrive as provider status,
   * so the bell row shows them; only a transport error is logged here.
   */
  updateCli: (providerId: ProviderId) => Promise<void>;
}

/** Mirrors the server's provider sign-in and rate-limit state behind the sidebar bell. */
export const useProviderStatusStore = create<State>((set, get) => ({
  statuses: [],
  fetch: async (force) => {
    try {
      const statuses = await getTransport().listProviderStatus(force);
      set({ statuses });
    } catch (err) {
      console.error("[providerStatusStore] Failed to load provider status", err);
    }
  },
  apply: (status) =>
    set((state) => {
      const others = state.statuses.filter((existing) => existing.providerId !== status.providerId);
      return { statuses: [...others, status] };
    }),
  updateCli: async (providerId) => {
    try {
      get().apply(await getTransport().updateProviderCli(providerId));
    } catch (err) {
      console.error("[providerStatusStore] Failed to update provider CLI", err);
    }
  },
}));
