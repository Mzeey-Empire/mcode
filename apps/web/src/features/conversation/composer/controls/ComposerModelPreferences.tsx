import { Check, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts";
import { supports1MContextWindow, supportsThinkingToggle } from "@/lib/model-registry";
import { useThreadStore } from "@/stores/threadStore";
import { cn } from "@/lib/utils";
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

function ComposerReasoningOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (state.reasoningLevels.length === 0) return null;

  return (
    <>
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted/60 select-none">Reasoning effort</div>
      {state.reasoningLevels.map((reasoning) => (
        <button
          key={reasoning}
          onClick={() => {
            actionProps.onSelectionChange({ reasoning });
            if (actionProps.threadId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { reasoningLevel: reasoning });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            actionProps.selection.reasoning === reasoning
              ? "bg-selected text-ink"
              : "text-ink hover:bg-selected/50 hover:text-ink",
          )}
        >
          <span>{reasoningLabel(reasoning)}</span>
          {actionProps.selection.reasoning === reasoning && <Check size={10} className="shrink-0 text-ink" />}
        </button>
      ))}
    </>
  );
}

function ComposerContextWindowOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.has1M) return null;

  return (
    <>
      {state.reasoningLevels.length > 0 && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted/60 select-none">Context window</div>
      {(["200k", "1m"] as const).map((nextContextWindow) => (
        <button
          key={nextContextWindow}
          onClick={() => {
            actionProps.onSelectionChange({ contextWindow: nextContextWindow });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { contextWindow: nextContextWindow });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            state.contextWindow === nextContextWindow
              ? "bg-selected text-ink"
              : "text-ink hover:bg-selected/50 hover:text-ink",
          )}
        >
          <span className="tabular-nums">{nextContextWindow === "1m" ? "1M tokens" : "200K tokens"}</span>
          {state.contextWindow === nextContextWindow && <Check size={10} className="shrink-0 text-ink" />}
        </button>
      ))}
    </>
  );
}

function ComposerThinkingOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.hasThinking) return null;

  return (
    <>
      {(state.reasoningLevels.length > 0 || state.has1M) && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted/60 select-none">Thinking</div>
      {[false, true].map((nextThinking) => (
        <button
          key={String(nextThinking)}
          onClick={() => {
            actionProps.onSelectionChange({ thinking: nextThinking });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { thinking: nextThinking });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            state.thinking === nextThinking
              ? "bg-selected text-ink"
              : "text-ink hover:bg-selected/50 hover:text-ink",
          )}
        >
          <span>{nextThinking ? "On" : "Off"}</span>
          {state.thinking === nextThinking && <Check size={10} className="shrink-0 text-ink" />}
        </button>
      ))}
    </>
  );
}

function ComposerFastModeOption({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.hasCodexFast) return null;

  return (
    <>
      {(state.reasoningLevels.length > 0 || state.has1M || state.hasThinking) && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted/60 select-none">Fast mode</div>
      <label
        className={cn(
          "flex w-full cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs",
          state.codexFastMode
            ? "bg-selected/50 text-ink"
            : "text-ink hover:bg-selected/50 hover:text-ink",
        )}
      >
        <span>Fast</span>
        <Switch
          data-testid="composer-codex-fast-switch"
          checked={state.codexFastMode}
          onCheckedChange={(checked) => {
            const codexFastMode = checked === actionProps.defaults.globalCodexFast ? null : checked;
            actionProps.onSelectionChange({ codexFastMode });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { codexFastMode });
            }
          }}
          aria-label="Fast mode"
          onClick={(event) => event.stopPropagation()}
        />
      </label>
    </>
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
    <div role="group" aria-label={state.preferenceTooltip}>
      <ComposerReasoningOptions state={state} actionProps={actionProps} />
      <ComposerContextWindowOptions state={state} actionProps={actionProps} />
      <ComposerThinkingOptions state={state} actionProps={actionProps} />
      <ComposerFastModeOption state={state} actionProps={actionProps} />
    </div>
  );
}
