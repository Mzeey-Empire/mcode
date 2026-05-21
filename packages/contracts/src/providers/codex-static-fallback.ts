import type { ProviderModelInfo } from "./models.js";

/**
 * Static Codex model rows. Codex does not support dynamic model discovery,
 * so these are returned directly from `CodexProvider.listModels()`.
 * Single source for both server and web model-registry fallback.
 */
export const CODEX_STATIC_MODELS: readonly ProviderModelInfo[] = [
  { id: "gpt-5.5", name: "GPT-5.5", group: "OpenAI" },
  { id: "gpt-5.4", name: "GPT-5.4", group: "OpenAI" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", group: "OpenAI" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", group: "OpenAI" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", group: "OpenAI" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", group: "OpenAI" },
];
