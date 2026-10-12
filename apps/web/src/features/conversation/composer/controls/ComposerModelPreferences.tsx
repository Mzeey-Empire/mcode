import { Brain, Maximize2, Zap, type LucideIcon } from "lucide-react";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { SteppedSlider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts";
import { supports1MContextWindow, supportsThinkingToggle } from "@/lib/model-registry";
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
  hasCodexFast: boolean;
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
  hasCodexFast: boolean,
): boolean {
  return reasoningLevels.length > 0 || has1M || hasThinking || hasCodexFast;
}

function reasoningLabel(level: string): string {
  if (level === "xhigh") return "X-High";
  if (level === "none") return "None";
  if (level === "minimal") return "Minimal";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function getPreferenceLabel(state: Omit<ModelPreferenceState, "preferenceLabel" | "preferenceTooltip" | "canShowPreferences">, selection: ComposerAgentSelection): string {
  if (state.reasoningLevels.length > 0) return reasoningLabel(selection.reasoning);
  if (state.hasThinking) return "Thinking";
  if (state.hasCodexFast) return state.codexFastMode ? "Fast" : "Off";
  return state.contextWindow === "1m" ? "1M" : "200K";
}

function getPreferenceTooltip(
  reasoningLevels: ReasoningLevel[],
  has1M: boolean,
  hasThinking: boolean,
  hasCodexFast: boolean,
): string {
  if (reasoningLevels.length > 0) {
    if (has1M || hasThinking || hasCodexFast) return "Reasoning and model options";
    return "Reasoning level";
  }
  if (hasThinking) return "Thinking";
  if (hasCodexFast) return "Fast mode";
  return "Context window";
}

function getModelPreferenceState(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
  reasoningLevels: ReasoningLevel[],
): ModelPreferenceState {
  const has1M = supportsClaudeModelOption(selection.provider, selection.modelId, supports1MContextWindow);
  const hasThinking = supportsClaudeModelOption(selection.provider, selection.modelId, supportsThinkingToggle);
  const hasCodexFast = selection.provider === "codex";
  const contextWindow = getContextWindow(selection, defaults);
  const thinking = getThinking(selection, defaults);
  const codexFastMode = getCodexFastMode(selection, defaults);
  const baseState = { has1M, hasThinking, hasCodexFast, contextWindow, thinking, codexFastMode, reasoningLevels };
  return {
    ...baseState,
    preferenceLabel: getPreferenceLabel(baseState, selection),
    preferenceTooltip: getPreferenceTooltip(reasoningLevels, has1M, hasThinking, hasCodexFast),
    canShowPreferences: hasAvailablePreference(reasoningLevels, has1M, hasThinking, hasCodexFast),
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
      {state.hasCodexFast && state.codexFastMode && (
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
  if (state.reasoningLevels.length === 0) return null;
  const { reasoning } = actionProps.selection;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-body-small text-muted">Reasoning</span>
        <span data-testid="composer-settings-label" className="text-fade text-body-small font-medium text-ink">
          {reasoningLabel(reasoning)}
        </span>
      </div>
      {/* One level leaves nothing to choose, and the header already names it. */}
      {state.reasoningLevels.length > 1 && (
        <SteppedSlider
          // An off-ladder level selects no stop, so choosing any stop, including the first, commits it.
          value={state.reasoningLevels.indexOf(reasoning)}
          stops={state.reasoningLevels.length}
          aria-label="Reasoning effort"
          getStopLabel={(stop) => reasoningLabel(state.reasoningLevels[stop] ?? reasoning)}
          onValueChange={(stop) => {
            const reasoning = state.reasoningLevels[stop];
            if (!reasoning) return;
            actionProps.onSelectionChange({ reasoning });
            persistThreadSetting(actionProps, { reasoningLevel: reasoning }, { skipForks: false });
          }}
        />
      )}
    </div>
  );
}

/**
 * An on/off option as a pill: the icon takes the accent when on, so a glance at the row shows
 * which options are active without reading a switch per line.
 */
function ComposerOptionChip({
  icon: Icon,
  label,
  pressed,
  onPressedChange,
}: {
  icon: LucideIcon;
  label: string;
  pressed: boolean;
  onPressedChange(pressed: boolean): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-body-small ring-1 ring-inset transition-colors duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none",
        pressed
          ? "bg-selected text-ink ring-transparent"
          : "text-muted ring-control-border hover:bg-hover hover:text-ink",
        FOCUS_RING_CLASS,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", pressed && "text-primary")}
      />
      {label}
    </button>
  );
}

function ComposerOptionChips({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.hasCodexFast && !state.has1M && !state.hasThinking) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {state.hasCodexFast && (
        <ComposerOptionChip
          icon={Zap}
          label="Fast"
          pressed={state.codexFastMode}
          onPressedChange={(checked) => {
            const codexFastMode = checked === actionProps.defaults.globalCodexFast ? null : checked;
            actionProps.onSelectionChange({ codexFastMode });
            persistThreadSetting(actionProps, { codexFastMode }, { skipForks: true });
          }}
        />
      )}
      {state.has1M && (
        <ComposerOptionChip
          icon={Maximize2}
          label="1M context"
          pressed={state.contextWindow === "1m"}
          onPressedChange={(on) => {
            const contextWindow: ContextWindowMode = on ? "1m" : "200k";
            actionProps.onSelectionChange({ contextWindow });
            persistThreadSetting(actionProps, { contextWindow }, { skipForks: true });
          }}
        />
      )}
      {state.hasThinking && (
        <ComposerOptionChip
          icon={Brain}
          label="Thinking"
          pressed={state.thinking}
          onPressedChange={(thinking) => {
            actionProps.onSelectionChange({ thinking });
            persistThreadSetting(actionProps, { thinking }, { skipForks: true });
          }}
        />
      )}
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
    <div role="group" aria-label={state.preferenceTooltip} className="flex w-full flex-col gap-3 px-1.5 py-1">
      <ComposerReasoningSlider state={state} actionProps={actionProps} />
      <ComposerOptionChips state={state} actionProps={actionProps} />
    </div>
  );
}
