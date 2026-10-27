import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { ProviderModelInfo } from "@mcode/contracts/providers/models";
import type { SendMessageInput } from "@mcode/contracts/ws/methods";

/** Composer options that only some providers (or some of a provider's models) understand. */
export type SwitchableOptions = Pick<
  SendMessageInput,
  "reasoningLevel" | "contextWindow" | "thinking" | "fastMode" | "devinMode"
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
 * `plan` and `permissions`, not composer options. Model catalogs declare Fast (`supportsFastMode`)
 * and reasoning levels, so those are checked against the target model instead. Nothing declares
 * context-window or Devin mode, so a new provider that adds one of these options must be listed here.
 */
const OPTION_OWNER: Partial<Record<keyof SwitchableOptions, ProviderId>> = {
  contextWindow: "claude",
  thinking: "claude",
  devinMode: "devin",
};

/**
 * Reconcile the composer's options against the provider and model the send is switching to.
 *
 * Provider-owned toggles (context-window mode, thinking, Devin mode) drop when another provider
 * receives the send. Fast drops unless the target model declares it, matching turn admission, which
 * sends Fast only to such models. A reasoning level drops only when the target model's catalog entry
 * lists levels and omits this one: a model missing from the catalog is not evidence that the level is
 * unsupported.
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

  for (const option of optionsOwnedElsewhere(kept, input.toProvider)) {
    drop(option, kept[option], `${input.toProvider} has no ${option} setting`);
  }
  if (kept.fastMode !== undefined && !modelSupportsFastMode(input.targetModel)) {
    drop("fastMode", kept.fastMode, `${input.targetModel?.id ?? input.toProvider} has no Fast mode`);
  }
  const level = kept.reasoningLevel;
  if (level !== undefined && !modelSupportsReasoningLevel(input.targetModel, level)) {
    drop("reasoningLevel", level, `${input.targetModel?.id} does not support the ${level} reasoning level`);
  }
  return { options: kept, dropped };
}

function optionsOwnedElsewhere(options: SwitchableOptions, toProvider: ProviderId): (keyof SwitchableOptions)[] {
  return (Object.keys(OPTION_OWNER) as (keyof SwitchableOptions)[])
    .filter((option) => options[option] !== undefined && OPTION_OWNER[option] !== toProvider);
}

function modelSupportsFastMode(model: ProviderModelInfo | null): boolean {
  return model?.supportsFastMode === true;
}

function modelSupportsReasoningLevel(model: ProviderModelInfo | null, level: string): boolean {
  const levels: readonly string[] | undefined = model?.supportedReasoningEfforts;
  return levels === undefined || levels.includes(level);
}
