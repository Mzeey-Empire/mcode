import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Brain, Zap } from "lucide-react";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { MENU_LIST_CLASS, MENU_ROW_CLASS, MenuRowBody } from "@/components/ui/menu-row";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts/models/settings";
import { findProviderModel, supportsThinkingToggle } from "@/lib/model-registry";
import { formatReasoningLabel } from "@/lib/format-model-label";
import { useThreadStore, type ThreadSettings } from "@/stores/threadStore";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import { moveOptionFocus } from "./AccessOptionList";

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
  fastMode: boolean;
  reasoningLevels: ReasoningLevel[];
  preferenceLabel: string;
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

function getFastMode(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  if (selection.fastMode === null) return defaults.globalCodexFast;
  return selection.fastMode;
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

function getPreferenceLabel(state: Omit<ModelPreferenceState, "preferenceLabel" | "canShowPreferences">, selection: ComposerAgentSelection): string {
  if (state.reasoningLevels.length > 0) return formatReasoningLabel(selection.reasoning);
  if (state.hasThinking) return "Thinking";
  if (state.hasFast) return state.fastMode ? "Fast" : "Off";
  return state.contextWindow === "1m" ? "1M" : "200K";
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
  const fastMode = getFastMode(selection, defaults);
  const baseState = { has1M, hasThinking, hasFast, contextWindow, thinking, fastMode, reasoningLevels };
  return {
    ...baseState,
    preferenceLabel: getPreferenceLabel(baseState, selection),
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
      {state.hasFast && state.fastMode && (
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
  actionProps: Pick<ComposerModelPreferencesProps, "threadId" | "branchFromMessageId">,
  settings: Partial<ThreadSettings>,
  { skipForks }: { skipForks: boolean },
) {
  if (!actionProps.threadId || (skipForks && actionProps.branchFromMessageId)) return;
  void useThreadStore.getState().setThreadSettings(actionProps.threadId, settings);
}

/** Saves a reasoning level to the thread, forks included, as every other way of changing it does. */
export function persistReasoningLevel(
  thread: Pick<ComposerModelPreferencesProps, "threadId" | "branchFromMessageId">,
  reasoningLevel: ReasoningLevel,
): void {
  persistThreadSetting(thread, { reasoningLevel }, { skipForks: false });
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
          pressed={state.fastMode}
          onPressedChange={(checked) => {
            const fastMode = checked === actionProps.defaults.globalCodexFast ? null : checked;
            actionProps.onSelectionChange({ fastMode });
            persistThreadSetting(actionProps, { fastMode }, { skipForks: true });
          }}
        >
          <Zap aria-hidden="true" className={cn("size-3.5", state.fastMode && "fill-current")} />
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

/** The selected model's on/off options (context window, Thinking, Fast), persisted to the thread as they change; null when it has none. */
export function ComposerModelPreferenceSettings({
  threadId,
  branchFromMessageId,
  selection,
  defaults,
  reasoningLevels,
  onSelectionChange,
}: ComposerModelPreferencesProps) {
  const state = getModelPreferenceState(selection, defaults, reasoningLevels);
  if (!state.has1M && !state.hasThinking && !state.hasFast) return null;
  const actionProps = { threadId, branchFromMessageId, selection, defaults, onSelectionChange };

  return (
    <div role="group" aria-label="Model options" className="flex min-h-6.5 w-full items-center justify-between gap-4 px-1.5 py-1">
      <span className="text-body-small text-muted">Options</span>
      <ComposerOptionToggles state={state} actionProps={actionProps} />
    </div>
  );
}

/** Props for {@link ComposerReasoningLevelList}. */
export interface ComposerReasoningLevelListProps extends ComposerModelPreferencesProps {
  /** Runs after a level is chosen, so the host can close its popover. */
  readonly onChosen: () => void;
}

/**
 * The model's reasoning levels as a single-choice listbox, the current one checked, as the access list is: focus
 * starts on the current level (the first when the current one is off the model's ladder), the arrow keys wrap, and
 * Enter, Space or a click chooses.
 */
export function ComposerReasoningLevelList({ reasoningLevels, onChosen, ...props }: ComposerReasoningLevelListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, []);
  if (reasoningLevels.length === 0) return null;
  const tabbable = reasoningLevels.includes(props.selection.reasoning) ? props.selection.reasoning : reasoningLevels[0];

  return (
    <div ref={listRef} role="listbox" aria-label="Reasoning" onKeyDown={moveOptionFocus} className={cn("relative", MENU_LIST_CLASS, "p-0")}>
      <SlidingHighlight follow={{ pointer: '[role="option"]' }} />
      {reasoningLevels.map((level) => (
        <button
          key={level}
          type="button"
          role="option"
          aria-selected={level === props.selection.reasoning}
          tabIndex={level === tabbable ? 0 : -1}
          onPointerMove={(event) => {
            if (event.pointerType !== "touch") event.currentTarget.focus();
          }}
          onClick={() => {
            props.onSelectionChange({ reasoning: level });
            persistReasoningLevel(props, level);
            onChosen();
          }}
          className={MENU_ROW_CLASS}
        >
          <MenuRowBody label={formatReasoningLabel(level)} checked={level === props.selection.reasoning} />
        </button>
      ))}
    </div>
  );
}
