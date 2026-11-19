import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { findProviderModel, normalizeReasoningLevel, type ModelDefinition } from "@/lib/model-registry";
import { ProviderIdSchema, type ReasoningLevel } from "@mcode/contracts/models/settings";

function catalogModel(providerId: string, modelId: string): ModelDefinition | undefined {
  return useProviderModelsStore.getState().models[providerId]?.find((model) => model.id === modelId)
    ?? findProviderModel(providerId, modelId);
}

/** Keeps the saved level when the model offers it, else moves to the model's default level. */
function supportedReasoning(providerId: string, modelId: string, reasoning: ReasoningLevel): ReasoningLevel {
  const model = catalogModel(providerId, modelId);
  const declared = model?.supportedReasoningLevels;
  if (!declared) return normalizeReasoningLevel(providerId, modelId, reasoning);
  if (declared.includes(reasoning)) return reasoning;
  return model?.defaultReasoningLevel ?? "medium";
}

/**
 * Sets the default provider and model for new threads in one settings write. The reasoning level is `level` when
 * given, else the saved level when the model offers it, else the model's default. The Threads page and search
 * results both call this, so a model from another provider never leaves the provider and model out of step.
 */
export async function chooseDefaultModel(providerId: string, modelId: string, level?: ReasoningLevel): Promise<void> {
  const { settings, update } = useSettingsStore.getState();
  const { provider, reasoning } = settings.model.defaults;
  // The model picker hands back a catalog provider id as a plain string; parse it before it reaches the settings.
  const nextProvider = ProviderIdSchema.parse(providerId);
  const nextReasoning = level ?? supportedReasoning(providerId, modelId, reasoning);
  await update({
    model: {
      defaults: {
        ...(nextProvider !== provider && { provider: nextProvider }),
        id: modelId,
        ...(nextReasoning !== reasoning && { reasoning: nextReasoning }),
      },
    },
  });
}
