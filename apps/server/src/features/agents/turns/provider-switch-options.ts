import type { ProviderId, ProviderModelInfo, SendMessageInput } from "@mcode/contracts";

/** Composer options that only some providers (or some of a provider's models) understand. */
export type SwitchableOptions = Pick<
  SendMessageInput,
  "reasoningLevel" | "contextWindow" | "thinking" | "codexFastMode" | "devinMode"
>;

/** One option the target could not honour, kept so the timeline can say what was dropped. */
export interface DroppedOption {
  readonly option: keyof SwitchableOptions;
  readonly value: string | boolean;
  readonly reason: string;
}

/** The options a switching send keeps, and the ones it loses with the reason for each. */
export interface ReconciledOptions {
  readonly options: SwitchableOptions;
  readonly dropped: readonly DroppedOption[];
}

/**
 * The provider that owns each option outright; every other provider drops it.
 *
 * Hardcoded because the capability descriptors (`ProviderCapabilityName`) name features such as
 * `plan` and `permissions`, not composer options, and per-model catalogs only describe reasoning
 * levels. Nothing declares which provider honours Fast or context-window mode, so a new provider
 * that adds one of these options must be listed here.
 */
const OPTION_OWNER: Partial<Record<keyof SwitchableOptions, ProviderId>> = {
  contextWindow: "claude",
  thinking: "claude",
  codexFastMode: "codex",
  devinMode: "devin",
};

/**
 * Reconcile the composer's options against the provider and model the send is switching to.
 *
 * Provider-owned toggles (Fast, context-window mode, thinking, Devin mode) drop when another provider
 * receives the send. A reasoning level drops only when the target model's catalog entry lists levels
 * and omits this one: a model missing from the catalog is not evidence that the level is unsupported.
 * Permission mode needs no mapping here: Mcode has two modes and every registered provider declares the
 * `permissions` capability, so neither mode is ever unsupported.
 */
export function reconcileSwitchOptions(input: {
  readonly options: SwitchableOptions;
  readonly toProvider: ProviderId;
  readonly targetModel: ProviderModelInfo | null;
}): ReconciledOptions {
  const kept: { -readonly [K in keyof SwitchableOptions]: SwitchableOptions[K] } = { ...input.options };
  const dropped: DroppedOption[] = [];
  const drop = (option: keyof SwitchableOptions, value: unknown, reason: string): void => {
    delete kept[option];
    dropped.push({ option, value: value as string | boolean, reason });
  };

  for (const option of Object.keys(OPTION_OWNER) as (keyof SwitchableOptions)[]) {
    const owner = OPTION_OWNER[option];
    if (kept[option] !== undefined && owner !== input.toProvider) {
      drop(option, kept[option], `${input.toProvider} has no ${option} setting`);
    }
  }
  const level = kept.reasoningLevel;
  const levels = input.targetModel?.supportedReasoningEfforts;
  if (level !== undefined && levels && !(levels as readonly string[]).includes(level)) {
    drop("reasoningLevel", level, `${input.targetModel?.id} does not support the ${level} reasoning level`);
  }
  return { options: kept, dropped };
}
