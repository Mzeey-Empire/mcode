import type { ProviderModelInfo } from "./models.js";

/**
 * Minimal Cursor model rows when CLI discovery fails (`cursor-agent models` unavailable).
 * Single source for server {@link CursorProvider.listModels} and web model-registry fallback UI.
 */
export const CURSOR_STATIC_MODEL_FALLBACK: readonly ProviderModelInfo[] = [
  { id: "auto", name: "Auto", group: "Cursor" },
  { id: "composer-2-fast", name: "Composer 2 Fast", group: "Cursor" },
];
