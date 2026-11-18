import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { MODEL_PROVIDERS, normalizeReasoningLevel, type ModelDefinition } from "@/lib/model-registry";
import type { ReasoningLevel, SettingsProviderId } from "@mcode/contracts/models/settings";

/**
 * Sets the default provider for new threads. Resets the default model to the new
 * provider's first model and normalises the reasoning level to one that model supports,
 * in one settings write. The Threads page and search results both call this.
 */
export async function chooseDefaultProvider(providerId: string): Promise<void> {
  const reasoning = useSettingsStore.getState().settings.model.defaults.reasoning;
  await useProviderModelsStore.getState().fetchModels(providerId);
  const newProvider = MODEL_PROVIDERS.find((p) => p.id === providerId);
  const dynamicFirst = useProviderModelsStore.getState().models[providerId]?.[0];
  const firstModel = dynamicFirst ?? newProvider?.models[0];
  let newReasoning: string = reasoning;
  if (firstModel) {
    const declared = firstModel.supportedReasoningLevels;
    if (declared) {
      newReasoning = (declared as readonly string[]).includes(reasoning)
        ? reasoning
        : (firstModel.defaultReasoningLevel ?? "medium");
    } else {
      newReasoning = normalizeReasoningLevel(providerId, firstModel.id, reasoning);
    }
  }
  await useSettingsStore.getState().update({
    model: {
      defaults: {
        provider: providerId as SettingsProviderId,
        ...(firstModel && { id: firstModel.id }),
        reasoning: newReasoning as ReasoningLevel,
      },
    },
  });
}

/**
 * Sets the default model for new threads, moving the reasoning level to the model's
 * default when the saved level is not one the model supports.
 *
 * @param modelId - Chosen model id.
 * @param selected - The chosen model's catalog entry, when it is listed.
 */
export async function chooseDefaultModel(modelId: string, selected: ModelDefinition | undefined): Promise<void> {
  const { settings, update } = useSettingsStore.getState();
  const { provider, reasoning } = settings.model.defaults;
  const declared = selected?.supportedReasoningLevels;
  let newReasoning: string = reasoning;
  if (declared) {
    // If the stored level isn't valid for this model, use its default
    if (!(declared as readonly string[]).includes(reasoning)) {
      newReasoning = selected?.defaultReasoningLevel ?? "medium";
    }
  } else {
    newReasoning = normalizeReasoningLevel(provider, modelId, reasoning);
  }
  await update({
    model: {
      defaults: {
        id: modelId,
        ...(newReasoning !== reasoning && { reasoning: newReasoning as ReasoningLevel }),
      },
    },
  });
}
