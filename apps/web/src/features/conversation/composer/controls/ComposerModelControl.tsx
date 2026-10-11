import { ModelSelector } from "@/components/chat/ModelSelector";
import {
  ComposerModelPreferenceSettings,
  ComposerModelPreferenceSummary,
  hasModelPreferences,
  type ComposerModelPreferenceDefaults,
} from "./ComposerModelPreferences";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { ReasoningLevel } from "@mcode/contracts";
import {
  getModelDefaultReasoningLevel,
  getModelReasoningLevels,
} from "@/lib/model-registry";

/** Props for the Composer's model control. */
export interface ComposerModelControlProps {
  threadId?: string;
  branchFromMessageId?: string;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  reasoningLevels: ReasoningLevel[];
  isModelLocked: boolean;
  isProviderLocked: boolean;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

/** Renders one trigger that selects the model and configures its reasoning, context, Thinking, and Fast settings. */
export function ComposerModelControl({
  threadId,
  branchFromMessageId,
  selection,
  defaults,
  reasoningLevels,
  isModelLocked,
  isProviderLocked,
  onSelectionChange,
}: ComposerModelControlProps) {
  const showPreferences = hasModelPreferences(selection, defaults, reasoningLevels);
  return (
    <ModelSelector
      selectedModelId={selection.modelId}
      selectedProviderId={selection.provider}
      onSelect={(modelId, provider) => {
        const patch: Partial<ComposerAgentSelection> = { modelId, provider };
        // Devin effort levels are part of the model id family; when the new
        // model cannot express the current reasoning level, snap to its
        // declared default so the pill and the wire id stay consistent.
        if (provider === "devin") {
          const levels = getModelReasoningLevels(modelId);
          if (levels?.length && !levels.includes(selection.reasoning)) {
            patch.reasoning = (getModelDefaultReasoningLevel(modelId) ?? levels[0]) as ReasoningLevel;
          }
        }
        onSelectionChange(patch);
      }}
      locked={isModelLocked}
      providerLocked={isProviderLocked}
      detail={showPreferences && (
        <ComposerModelPreferenceSummary
          selection={selection}
          defaults={defaults}
          reasoningLevels={reasoningLevels}
        />
      )}
      settings={showPreferences && (
        <ComposerModelPreferenceSettings
          threadId={threadId}
          branchFromMessageId={branchFromMessageId}
          selection={selection}
          defaults={defaults}
          reasoningLevels={reasoningLevels}
          onSelectionChange={onSelectionChange}
        />
      )}
    />
  );
}
