import type { ContextWindowMode } from "@mcode/contracts";
import { getModelContextWindow } from "@mcode/shared/model-context";

/** Input parameters for context window resolution. */
export interface ResolveContextWindowParams {
  /** Context window reported by the Claude Agent SDK runtime. */
  sdkContextWindow: number | undefined;
  /** Model ID that actually ran (post-fallback). */
  modelId: string;
  /**
   * Effective context window mode for this thread.
   * Per-thread override > settings default > "200k".
   */
  contextWindowMode: ContextWindowMode;
  /** Previously stored numeric context window for this thread, used as final fallback. */
  previousContextWindow: number | undefined;
}

/**
 * Resolves the numeric context window (tokens) to display for a thread.
 *
 * Preference chain (highest to lowest priority):
 * 1. SDK runtime value (truthful — the SDK reports what it actually sent).
 * 2. Static map keyed on (modelId, mode). Falls back to 200k for unknown models.
 * 3. Previously stored value (smooths a transient gap during reconnect).
 */
export function resolveContextWindow(params: ResolveContextWindowParams): number | undefined {
  const { sdkContextWindow, modelId, contextWindowMode, previousContextWindow } = params;
  if (sdkContextWindow !== undefined) {
    return sdkContextWindow;
  }
  const fromMap = getModelContextWindow(modelId, contextWindowMode);
  if (fromMap !== undefined) {
    return fromMap;
  }
  return previousContextWindow;
}
