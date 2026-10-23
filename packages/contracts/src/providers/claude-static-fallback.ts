import type { ProviderModelInfo } from "./models.js";

/** Claude models superseded by a newer release in the same family. The picker folds these away. */
const CLAUDE_LEGACY_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
]);

/** Snapshot suffix the Anthropic Models API appends to an alias, e.g. `-20250514`. */
const DATED_SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Marks a Claude model legacy when its id, or the alias of a dated snapshot, is in the legacy list.
 * The suffix must be a date: a plain prefix match would fold `claude-opus-5-5` under `claude-opus-5`.
 */
export function withClaudeLifecycle(model: ProviderModelInfo): ProviderModelInfo {
  const legacy = CLAUDE_LEGACY_MODEL_IDS.has(model.id.replace(DATED_SNAPSHOT_SUFFIX, ""));
  return legacy ? { ...model, lifecycle: "legacy" } : model;
}

/** Complete Claude fallback catalog shared by server discovery and web pickers. */
export const CLAUDE_STATIC_MODELS: readonly ProviderModelInfo[] = ([
  ...[
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-opus-4-7", "Claude Opus 4.7"],
  ].map(([id, name]): ProviderModelInfo => ({
    id,
    name,
    contextWindow: 1_000_000,
    contextWindowOptions: ["200k", "1m"],
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  })),
  ...[
    ["claude-opus-4-6", "Claude Opus 4.6"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ].map(([id, name]): ProviderModelInfo => ({
    id,
    name,
    contextWindow: 1_000_000,
    contextWindowOptions: ["200k", "1m"],
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    defaultReasoningEffort: "high",
  })),
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    supportsReasoning: false,
  },
] satisfies ProviderModelInfo[]).map(withClaudeLifecycle);
