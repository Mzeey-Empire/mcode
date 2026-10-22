import type { ReactNode } from "react";
import { Brain, Zap } from "lucide-react";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { SteppedSlider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts";
import { findProviderModel, supportsThinkingToggle } from "@/lib/model-registry";
import { formatReasoningLabel } from "@/lib/format-model-label";
import { useThreadStore, type ThreadSettings } from "@/stores/threadStore";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";

/** Defaults that model preferences use when no thread override exists. */
export interface ComposerModelPreferenceDefaults {
  contextWindow: ContextWindowMode | undefined;
  thinking: boolean | undefined;
  globalCodexFast: boolean;
}

/** Props for Composer model preference controls. */
export interface ComposerModelPreferencesProps {
  threadId?: string;
  branchFromMessageId?: string;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  reasoningLevels: ReasoningLevel[];
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

interface ModelPreferenceState {
  has1M: boolean;
  hasThinking: boolean;
  hasFast: boolean;
  contextWindow: ContextWindowMode;
  thinking: boolean;
  codexFastMode: boolean;
  reasoningLevels: ReasoningLevel[];
  preferenceLabel: string;
  preferenceTooltip: string;
  canShowPreferences: boolean;
}

interface ModelPreferenceActionProps {
  threadId: string | undefined;
  branchFromMessageId: string | undefined;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

function supportsClaudeModelOption(
  provider: ComposerAgentSelection["provider"],
  modelId: string,
  supportsOption: (modelId: string) => boolean,
): boolean {
  return provider === "claude" && supportsOption(modelId);
}

function getCodexFastMode(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  if (selection.codexFastMode === null) return defaults.globalCodexFast;
  return selection.codexFastMode;
}

function getContextWindow(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): ContextWindowMode {
  return selection.contextWindow ?? defaults.contextWindow ?? "200k";
}

function getThinking(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  return selection.thinking ?? defaults.thinking ?? false;
}

function hasAvailablePreference(
  reasoningLevels: ReasoningLevel[],
  has1M: boolean,
  hasThinking: boolean,
  hasFast: boolean,
): boolean {
  return reasoningLevels.length > 0 || has1M || hasThinking || hasFast;
}

function getPreferenceLabel(state: Omit<ModelPreferenceState, "preferenceLabel" | "preferenceTooltip" | "canShowPreferences">, selection: ComposerAgentSelection): string {
  if (state.reasoningLevels.length > 0) return formatReasoningLabel(selection.reasoning);
  if (state.hasThinking) return "Thinking";
  if (state.hasFast) return state.codexFastMode ? "Fast" : "Off";
  return state.contextWindow === "1m" ? "1M" : "200K";
}

function getPreferenceTooltip(
  reasoningLevels: ReasoningLevel[],
  has1M: boolean,
  hasThinking: boolean,
  hasFast: boolean,
): string {
  if (reasoningLevels.length > 0) {
    if (has1M || hasThinking || hasFast) return "Reasoning and model options";
    return "Reasoning level";
  }
  if (hasThinking) return "Thinking";
  if (hasFast) return "Fast mode";
  return "Context window";
}

function getModelPreferenceState(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
  reasoningLevels: ReasoningLevel[],
): ModelPreferenceState {
  const model = findProviderModel(selection.provider, selection.modelId);
  const has1M = model?.contextWindowOptions?.includes("1m") === true;
  const hasThinking = supportsClaudeModelOption(selection.provider, selection.modelId, supportsThinkingToggle);
  const hasFast = model?.supportsFastMode === true;
  const contextWindow = getContextWindow(selection, defaults);
  const thinking = getThinking(selection, defaults);
  const codexFastMode = getCodexFastMode(selection, defaults);
  const baseState = { has1M, hasThinking, hasFast, contextWindow, thinking, codexFastMode, reasoningLevels };
  return {
    ...baseState,
    preferenceLabel: getPreferenceLabel(baseState, selection),
    preferenceTooltip: getPreferenceTooltip(reasoningLevels, has1M, hasThinking, hasFast),
    canShowPreferences: hasAvailablePreference(reasoningLevels, has1M, hasThinking, hasFast),
  };
}

/** Whether the selected model exposes any reasoning, context window, Thinking, or Fast setting. */
export function hasModelPreferences(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
  reasoningLevels: ReasoningLevel[],
): boolean {
  return getModelPreferenceState(selection, defaults, reasoningLevels).canShowPreferences;
}

function ComposerModelPreferenceSummaryContent({ state }: { state: ModelPreferenceState }) {
  return (
    <>
      {state.hasFast && state.codexFastMode && (
        <Zap
          size={12}
          aria-hidden="true"
          data-testid="composer-fast-mode-icon"
          className="size-3 shrink-0 text-ink/80"
        />
      )}
      <span data-testid="composer-model-preference-label">{state.preferenceLabel}</span>
      {state.reasoningLevels.length > 0 && state.has1M && state.contextWindow === "1m" && (
        <span
          data-testid="composer-1m-badge"
          className="rounded-sm bg-ink/5 px-1 py-px text-xs font-medium uppercase tracking-wide text-ink/80 ring-1 ring-inset ring-ink/10 tabular-nums"
        >
          1M
        </span>
      )}
    </>
  );
}

function persistThreadSetting(
  actionProps: ModelPreferenceActionProps,
  settings: Partial<ThreadSettings>,
  { skipForks }: { skipForks: boolean },
) {
  if (!actionProps.threadId || (skipForks && actionProps.branchFromMessageId)) return;
  void useThreadStore.getState().setThreadSettings(actionProps.threadId, settings);
}

function ComposerReasoningSlider({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  // One level leaves nothing to choose, and the header already names it.
  if (state.reasoningLevels.length < 2) return null;
  const { reasoning } = actionProps.selection;

  return (
    <SteppedSlider
      // An off-ladder level selects no stop, so choosing any stop, including the first, commits it.
      value={state.reasoningLevels.indexOf(reasoning)}
      stops={state.reasoningLevels.length}
      aria-label="Reasoning effort"
      getStopLabel={(stop) => formatReasoningLabel(state.reasoningLevels[stop] ?? reasoning)}
      onValueChange={(stop) => {
        const reasoning = state.reasoningLevels[stop];
        if (!reasoning) return;
        actionProps.onSelectionChange({ reasoning });
        persistThreadSetting(actionProps, { reasoningLevel: reasoning }, { skipForks: false });
      }}
    />
  );
}

/** An on/off model option as a small icon button; the tooltip carries the name the icon leaves out. */
function ComposerOptionToggle({
  label,
  pressed,
  onPressedChange,
  children,
}: {
  label: string;
  pressed: boolean;
  onPressedChange(pressed: boolean): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={() => onPressedChange(!pressed)}
            className={cn(
              "inline-flex h-6.5 min-w-6.5 cursor-pointer items-center justify-center rounded-md px-1.5 text-caption font-semibold transition-colors duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none",
              pressed ? "bg-selected text-primary" : "text-muted hover:bg-hover hover:text-ink",
              FOCUS_RING_CLASS,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function ComposerOptionToggles({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {state.hasFast && (
        <ComposerOptionToggle
          label="Fast"
          pressed={state.codexFastMode}
          onPressedChange={(checked) => {
            const codexFastMode = checked === actionProps.defaults.globalCodexFast ? null : checked;
            actionProps.onSelectionChange({ codexFastMode });
            persistThreadSetting(actionProps, { codexFastMode }, { skipForks: true });
          }}
        >
          <Zap aria-hidden="true" className={cn("size-3.5", state.codexFastMode && "fill-current")} />
        </ComposerOptionToggle>
      )}
      {state.has1M && (
        <ComposerOptionToggle
          label="1M context"
          pressed={state.contextWindow === "1m"}
          onPressedChange={(on) => {
            const contextWindow: ContextWindowMode = on ? "1m" : "200k";
            actionProps.onSelectionChange({ contextWindow });
            persistThreadSetting(actionProps, { contextWindow }, { skipForks: true });
          }}
        >
          1M
        </ComposerOptionToggle>
      )}
      {state.hasThinking && (
        <ComposerOptionToggle
          label="Thinking"
          pressed={state.thinking}
          onPressedChange={(thinking) => {
            actionProps.onSelectionChange({ thinking });
            persistThreadSetting(actionProps, { thinking }, { skipForks: true });
          }}
        >
          <Brain aria-hidden="true" className="size-3.5" />
        </ComposerOptionToggle>
      )}
    </div>
  );
}

function ComposerSettingsHeader({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  return (
    <div className="flex min-h-6.5 items-center justify-between gap-4">
      {state.reasoningLevels.length > 0 ? (
        <span className="flex min-w-0 items-baseline gap-2 text-body-small">
          <span className="text-muted">Reasoning</span>
          <span data-testid="composer-settings-label" className="text-fade font-medium text-ink">
            {formatReasoningLabel(actionProps.selection.reasoning)}
          </span>
        </span>
      ) : (
        <span className="text-body-small text-muted">Options</span>
      )}
      <ComposerOptionToggles state={state} actionProps={actionProps} />
    </div>
  );
}

/** The selected model's preference summary for the model trigger, such as "High" or "Fast"; null when the model has none. */
export function ComposerModelPreferenceSummary({
  selection,
  defaults,
  reasoningLevels,
}: Pick<ComposerModelPreferencesProps, "selection" | "defaults" | "reasoningLevels">) {
  const state = getModelPreferenceState(selection, defaults, reasoningLevels);
  if (!state.canShowPreferences) return null;
  return <ComposerModelPreferenceSummaryContent state={state} />;
}

/** The selected model's settings (reasoning, context window, Thinking, Fast), persisted to the thread as they change. */
export function ComposerModelPreferenceSettings({
  threadId,
  branchFromMessageId,
  selection,
  defaults,
  reasoningLevels,
  onSelectionChange,
}: ComposerModelPreferencesProps) {
  const state = getModelPreferenceState(selection, defaults, reasoningLevels);
  if (!state.canShowPreferences) return null;
  const actionProps = { threadId, branchFromMessageId, selection, defaults, onSelectionChange };

  return (
    <div role="group" aria-label={state.preferenceTooltip} className="flex w-full flex-col gap-2 px-1.5 py-1">
      <ComposerSettingsHeader state={state} actionProps={actionProps} />
      <ComposerReasoningSlider state={state} actionProps={actionProps} />
    </div>
  );
}
