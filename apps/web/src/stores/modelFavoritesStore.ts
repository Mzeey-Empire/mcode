import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** Maximum starred models kept locally so composer menus stay fast to render. */
const MAX_FAVORITES = 40;

/** One starred model row persisted for quick selection in the composer. */
export interface ModelFavoriteEntry {
  providerId: string;
  modelId: string;
  label: string;
}

/** Persisted favorite models for {@link ModelSelector}. */
interface ModelFavoritesState {
  entries: ModelFavoriteEntry[];
  /** Adds or removes a favorite keyed by provider and model id. */
  toggleFavorite: (entry: ModelFavoriteEntry) => void;
  isFavorite: (providerId: string, modelId: string) => boolean;
}

/** Zustand store persisted to localStorage for starred composer models. */
export const useModelFavoritesStore = create<ModelFavoritesState>()(
  persist(
    (set, get) => ({
      entries: [],
      toggleFavorite: (entry) => {
        const label = entry.label.trim() || entry.modelId;
        set((s) => {
          const idx = s.entries.findIndex(
            (e) => e.providerId === entry.providerId && e.modelId === entry.modelId,
          );
          if (idx >= 0) {
            const next = [...s.entries];
            next.splice(idx, 1);
            return { entries: next };
          }
          const row: ModelFavoriteEntry = {
            providerId: entry.providerId,
            modelId: entry.modelId,
            label,
          };
          return { entries: [row, ...s.entries].slice(0, MAX_FAVORITES) };
        });
      },
      isFavorite: (providerId, modelId) =>
        get().entries.some((e) => e.providerId === providerId && e.modelId === modelId),
    }),
    {
      name: "mcode-model-favorites",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);
