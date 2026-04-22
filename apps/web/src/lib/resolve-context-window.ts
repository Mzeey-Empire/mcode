/** Input parameters for context window resolution. */
export interface ResolveContextWindowParams {
  /** Context window reported by the Claude Agent SDK runtime. */
  sdkContextWindow: number | undefined;
  /** Model ID that actually ran (post-fallback). */
  modelId: string;
  /** The user's configured default model ID from settings. */
  defaultModelId: string;
  /** User's explicit context window override from settings. */
  settingsContextWindow: number | undefined;
  /** Context window from the model registry (API-fetched or static). */
  registryContextWindow: number | undefined;
  /** Previously stored context window for this thread. */
  previousContextWindow: number | undefined;
}

/**
 * Resolves the context window to display for a thread.
 *
 * Preference chain (highest to lowest priority):
 * 1. User settings override (only when the thread's model matches the default)
 * 2. Model registry (API-fetched or static)
 * 3. SDK runtime value
 * 4. Previously stored value
 */
export function resolveContextWindow(params: ResolveContextWindowParams): number | undefined {
  const {
    sdkContextWindow,
    modelId,
    defaultModelId,
    settingsContextWindow,
    registryContextWindow,
    previousContextWindow,
  } = params;

  // User override only applies to the default model.
  if (settingsContextWindow !== undefined && modelId === defaultModelId) {
    return settingsContextWindow;
  }

  return registryContextWindow ?? sdkContextWindow ?? previousContextWindow;
}
