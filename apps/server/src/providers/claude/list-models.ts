/**
 * Fetches available Claude models from the Anthropic REST API.
 *
 * Returns ProviderModelInfo[] with contextWindow populated from
 * max_input_tokens. Results are cached in-memory with a 5-minute TTL
 * to avoid hammering the API on repeated model selector hovers.
 */

import { logger } from "@mcode/shared";
import type { ProviderModelInfo } from "@mcode/contracts";

/** Cache TTL: 5 minutes, matching the design spec. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Shape of a single model from the Anthropic Models API. */
interface AnthropicModelInfo {
  id: string;
  display_name: string;
  type: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
}

/** Paginated response from GET /v1/models. */
interface AnthropicModelsResponse {
  data: AnthropicModelInfo[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

let cachedModels: ProviderModelInfo[] | null = null;
let cacheTimestamp = 0;
let inflight: Promise<ProviderModelInfo[]> | null = null;

/** Reset the in-memory cache. Exposed for testing. */
export function resetModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
  inflight = null;
}

/**
 * Performs the actual network request to the Anthropic Models API.
 *
 * Populates the in-memory cache on success. Does not guard against
 * concurrent callers — use listClaudeModels() which coalesces inflight
 * requests onto a single promise.
 */
async function fetchModels(): Promise<ProviderModelInfo[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  // limit=100 covers all current Claude models without pagination.
  // Anthropic has far fewer than 100 Claude models at present, so we
  // intentionally do not follow has_more / last_id pagination.
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Anthropic Models API returned ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as AnthropicModelsResponse;

  const models: ProviderModelInfo[] = body.data
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => ({
      id: m.id,
      name: m.display_name,
      contextWindow: m.max_input_tokens ?? undefined,
    }));

  cachedModels = models;
  cacheTimestamp = Date.now();

  logger.debug("Fetched Claude models from API", { count: models.length });

  return models;
}

/**
 * Fetch Claude models from the Anthropic REST API.
 *
 * Reads `ANTHROPIC_API_KEY` from the environment (same var the Claude
 * Agent SDK uses). Filters to `claude-*` models and maps each to
 * `ProviderModelInfo` with `contextWindow` from `max_input_tokens`.
 *
 * Results are cached for CACHE_TTL_MS. Concurrent callers during a
 * cache miss share a single inflight promise to prevent stampedes.
 */
export async function listClaudeModels(): Promise<ProviderModelInfo[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }
  if (inflight) return inflight;

  inflight = fetchModels().finally(() => {
    inflight = null;
  });
  return inflight;
}
