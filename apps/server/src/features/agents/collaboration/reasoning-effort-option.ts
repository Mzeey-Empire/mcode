import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import type { ProviderModelInfo } from "@mcode/contracts/providers/models";
import type { ThreadTargetModelOption } from "@mcode/contracts/thread-control";
import { orderReasoningLevels, reasoningLevelAtOrBelow } from "@mcode/shared/model-effort";

/** Outcome of checking a requested reasoning level against a model's listed option. */
export type ReasoningLevelSelection =
  | { ok: true; level: ReasoningLevel | undefined }
  | { ok: false; message: string };

/**
 * The reasoning-effort option a model lists in thread_target_list, or `undefined` when it
 * declares no levels. The default is the user's level when listed, else the nearest listed
 * level below it, else (every listed level is above it) the model's declared default when
 * listed, else the lowest listed level. Delegation's single derivation, used by both the
 * list and the launch, so they cannot disagree.
 */
export function reasoningEffortOption(
  model: Pick<ProviderModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort">,
  userDefault: ReasoningLevel,
): ThreadTargetModelOption | undefined {
  const values = orderReasoningLevels(model.supportedReasoningEfforts ?? []);
  const lowest = values[0];
  if (!lowest) return undefined;
  const declared = model.defaultReasoningEffort;
  return {
    id: "reasoningEffort",
    values,
    default: reasoningLevelAtOrBelow(userDefault, values)
      ?? (declared && values.includes(declared) ? declared : lowest),
  };
}

/**
 * Picks the level a delegated child runs at. A requested level must be listed: it is
 * rejected, never clamped, so the Coordinator learns what the model accepts.
 */
export function selectReasoningLevel(
  modelId: string,
  option: ThreadTargetModelOption | undefined,
  requested: ReasoningLevel | undefined,
): ReasoningLevelSelection {
  if (requested === undefined) return { ok: true, level: option?.default };
  if (!option) return { ok: false, message: `${modelId} does not accept options.reasoningEffort. Omit it.` };
  if (!option.values.includes(requested)) {
    return {
      ok: false,
      message: `${modelId} accepts options.reasoningEffort ${option.values.join(", ")}; got ${requested}. Omit it to use ${option.default}.`,
    };
  }
  return { ok: true, level: requested };
}
