import type { ProviderModelInfo } from "./models.js";
import { CURSOR_CLI_MODEL_SNAPSHOT } from "./cursor-cli-models-snapshot.js";

/**
 * Cursor model rows when CLI discovery fails (`cursor-agent models` unavailable).
 * Uses the checked-in CLI snapshot; regenerate with
 * `bun apps/server/scripts/sync-cursor-models-snapshot.ts`.
 */
export const CURSOR_STATIC_MODEL_FALLBACK: readonly ProviderModelInfo[] =
  CURSOR_CLI_MODEL_SNAPSHOT;
