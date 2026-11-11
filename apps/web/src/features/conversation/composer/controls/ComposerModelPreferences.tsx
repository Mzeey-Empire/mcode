import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { Zap } from "lucide-react";
import { MENU_LIST_CLASS, MENU_ROW_CLASS, MenuRowBody } from "@/components/ui/menu-row";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { Switch } from "@/components/ui/switch";
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

interface ModelOptionToggle {
  readonly label: string;
  readonly on: boolean;
  readonly set: (on: boolean) => void;
}

function modelOptionToggles(state: ModelPreferenceState, actionProps: ModelPreferenceActionProps): ModelOptionToggle[] {
  const toggles: ModelOptionToggle[] = [];
  const change = (patch: Partial<ThreadSettings> & Partial<ComposerAgentSelection>) => {
    actionProps.onSelectionChange(patch);
    persistThreadSetting(actionProps, patch, { skipForks: true });
  };
  if (state.hasFast) {
    toggles.push({
      label: "Fast",
      on: state.fastMode,
      // Matching the global default stores no override, so the thread keeps following the setting.
      set: (on) => change({ fastMode: on === actionProps.defaults.globalCodexFast ? null : on }),
    });
  }
  if (state.has1M) {
    toggles.push({ label: "1M context", on: state.contextWindow === "1m", set: (on) => change({ contextWindow: on ? "1m" : "200k" }) });
  }
  if (state.hasThinking) {
    toggles.push({ label: "Thinking", on: state.thinking, set: (thinking) => change({ thinking }) });
  }
  return toggles;
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

/**
 * The selected model's on/off options (context window, Thinking, Fast) as labelled switch rows, persisted to the thread
 * as they change; null when it has none. Rows carry no inline padding, so each host lines the labels up with its list
 * through `className`.
 */
export function ComposerModelPreferenceSettings({
  threadId,
  branchFromMessageId,
  selection,
  defaults,
  reasoningLevels,
  onSelectionChange,
  className,
}: ComposerModelPreferencesProps & { readonly className?: string }) {
  const state = getModelPreferenceState(selection, defaults, reasoningLevels);
  const toggles = modelOptionToggles(state, { threadId, branchFromMessageId, selection, defaults, onSelectionChange });
  if (toggles.length === 0) return null;

  return (
    <div role="group" aria-label="Model options" className={cn("flex flex-col", className)}>
      {toggles.map((toggle) => (
        <label key={toggle.label} className="flex h-row-compact cursor-pointer items-center justify-between gap-3 text-body-small text-ink">
          {toggle.label}
          <Switch checked={toggle.on} onCheckedChange={toggle.set} />
        </label>
      ))}
    </div>
  );
}

/** Props for {@link ReasoningLevelOptions}. */
export interface ReasoningLevelOptionsProps {
  readonly levels: readonly ReasoningLevel[];
  /** The level drawn with a check, or undefined for a model other than the selected one. */
  readonly checked: ReasoningLevel | undefined;
  /** The listbox's accessible name. */
  readonly label: string;
  readonly onChoose: (level: ReasoningLevel) => void;
  /**
   * Behaves as a menu of its own: takes focus on mount and moves focus with the pointer. Off beside a search field,
   * which must keep focus so typing still works.
   */
  readonly takesFocus?: boolean;
  /** Uses the picker list's 8px row inset instead of the menu's 12px, so a pane's rows line up with the list beside it. */
  readonly listInset?: boolean;
}

/**
 * Reasoning levels as a single-choice listbox: the arrow keys wrap, and Enter, Space or a click chooses. Focus enters
 * on the checked level, or the first when none is checked.
 */
export function ReasoningLevelOptions({ levels, checked, label, onChoose, takesFocus = false, listInset = false }: ReasoningLevelOptionsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (takesFocus) listRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [takesFocus]);
  const tabbable = checked !== undefined && levels.includes(checked) ? checked : levels[0];

  return (
    <div ref={listRef} role="listbox" aria-label={label} onKeyDown={moveOptionFocus} className={cn("relative", MENU_LIST_CLASS, "p-0")}>
      <SlidingHighlight follow={{ pointer: '[role="option"]' }} />
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="option"
          aria-selected={level === checked}
          tabIndex={level === tabbable ? 0 : -1}
          onPointerMove={takesFocus ? focusUnderPointer : undefined}
          onClick={() => onChoose(level)}
          className={cn(MENU_ROW_CLASS, listInset && "px-2")}
        >
          <MenuRowBody label={formatReasoningLabel(level)} checked={level === checked} />
        </button>
      ))}
    </div>
  );
}

function focusUnderPointer(event: PointerEvent<HTMLElement>): void {
  if (event.pointerType !== "touch") event.currentTarget.focus();
}

/** Props for {@link ComposerReasoningLevelList}. */
export interface ComposerReasoningLevelListProps extends ComposerModelPreferencesProps {
  /** Runs after a level is chosen, so the host can close its popover. */
  readonly onChosen: () => void;
}

/** The reasoning popover's body: the selected model's levels, the current one checked, chosen in one click. */
export function ComposerReasoningLevelList({ reasoningLevels, onChosen, ...props }: ComposerReasoningLevelListProps) {
  if (reasoningLevels.length === 0) return null;
  return (
    <ReasoningLevelOptions
      takesFocus
      levels={reasoningLevels}
      checked={props.selection.reasoning}
      label="Reasoning"
      onChoose={(level) => {
        props.onSelectionChange({ reasoning: level });
        persistReasoningLevel(props, level);
        onChosen();
      }}
    />
  );
}
