import { MENU_LIST_CLASS, MENU_ROW_CLASS, MenuRowBody } from "@/components/ui/menu-row";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { Brain, Network, Zap, type LucideIcon } from "lucide-react";
import { ORCHESTRATION_MODES } from "@mcode/contracts/models/enums";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { findProviderModel, supportsThinkingToggle } from "@/lib/model-registry";
import { formatReasoningLabel } from "@/lib/format-model-label";
import { useThreadStore, type ThreadSettings } from "@/stores/threadStore";
import { resolveComposerCapabilities } from "../composer-capabilities";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import { moveOptionFocus } from "./AccessOptionList";

/** Defaults that model preferences use when no thread override exists. */
export interface ComposerModelPreferenceDefaults {
  thinking: boolean | undefined;
  globalCodexFast: boolean;
}

/** Props for Composer model preference controls. */
export interface ComposerModelPreferencesProps {
  threadId?: string;
  branchFromMessageId?: string;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

interface ModelPreferenceState {
  hasThinking: boolean;
  hasFast: boolean;
  thinking: boolean;
  fastMode: boolean;
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

function getThinking(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  return selection.thinking ?? defaults.thinking ?? false;
}

function getModelPreferenceState(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): ModelPreferenceState {
  const model = findProviderModel(selection.provider, selection.modelId);
  const hasThinking = supportsClaudeModelOption(selection.provider, selection.modelId, supportsThinkingToggle);
  const hasFast = model?.supportsFastMode === true;
  const thinking = getThinking(selection, defaults);
  const fastMode = getFastMode(selection, defaults);
  return { hasThinking, hasFast, thinking, fastMode };
}

/** Whether the selected model runs in Fast mode, from the thread's override or the global default. */
export function isFastModeOn(selection: ComposerAgentSelection, defaults: ComposerModelPreferenceDefaults): boolean {
  const state = getModelPreferenceState(selection, defaults);
  return state.hasFast && state.fastMode;
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
  readonly icon: LucideIcon;
  readonly on: boolean;
  readonly set: (on: boolean) => void;
}

/** The selected model's options: Fast as its own speed choice, then the on/off modes the model offers. */
interface ModelOptions {
  readonly fast: Omit<ModelOptionToggle, "label" | "icon"> | null;
  readonly toggles: readonly ModelOptionToggle[];
}

function modelOptionsOf(state: ModelPreferenceState, actionProps: ModelPreferenceActionProps): ModelOptions {
  const change = (patch: Partial<ThreadSettings> & Partial<ComposerAgentSelection>) => {
    actionProps.onSelectionChange(patch);
    persistThreadSetting(actionProps, patch, { skipForks: true });
  };
  const toggles: ModelOptionToggle[] = [];
  if (state.hasThinking) {
    toggles.push({ label: "Thinking", icon: Brain, on: state.thinking, set: (thinking) => change({ thinking }) });
  }
  const { selection } = actionProps;
  const orchestration = resolveComposerCapabilities({ providerId: selection.provider, modelId: selection.modelId })
    .find((capability) => capability.id === "orchestration");
  if (orchestration) {
    toggles.push({
      label: orchestration.label,
      icon: Network,
      on: selection.orchestrationMode === ORCHESTRATION_MODES.PROACTIVE,
      set: (on) => change({ orchestrationMode: on ? ORCHESTRATION_MODES.PROACTIVE : ORCHESTRATION_MODES.STANDARD }),
    });
  }
  return {
    fast: state.hasFast
      ? {
          on: state.fastMode,
          // Matching the global default stores no override, so the thread keeps following the setting.
          set: (on) => change({ fastMode: on === actionProps.defaults.globalCodexFast ? null : on }),
        }
      : null,
    toggles,
  };
}

const SPEED_OPTIONS = [
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast", icon: <Zap aria-hidden className="size-[1.4rem]" /> },
] as const;

/**
 * The selected model's options in a row, persisted to the thread as they change: Standard or Fast as a segmented
 * choice, then a pressed toggle for each mode the model offers (Thinking, Ultra or Ultracode). Renders nothing for a
 * model with none.
 */
export function ComposerModelOptions({
  threadId,
  branchFromMessageId,
  selection,
  defaults,
  onSelectionChange,
}: ComposerModelPreferencesProps) {
  const state = getModelPreferenceState(selection, defaults);
  const { fast, toggles } = modelOptionsOf(state, { threadId, branchFromMessageId, selection, defaults, onSelectionChange });
  if (!fast && toggles.length === 0) return null;

  return (
    <div role="group" aria-label="Model options" className="flex min-w-0 items-center gap-2">
      {fast && (
        <SegmentedControl
          variant="pill"
          size="small"
          aria-label="Speed"
          options={SPEED_OPTIONS}
          value={fast.on ? "fast" : "standard"}
          onChange={(value) => fast.set(value === "fast")}
        />
      )}
      {toggles.map(({ label, icon: Icon, on, set }) => (
        // Off, a mode rests as bare text like the access button beside it, so the footer carries one filled strip;
        // on, it takes the selected fill.
        <button
          key={label}
          type="button"
          aria-pressed={on}
          onClick={() => set(!on)}
          className={cn(
            "inline-flex h-[2.6rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption whitespace-nowrap transition-colors duration-(--duration-fast) ease-(--ease-standard)",
            FOCUS_RING_CLASS,
            on ? "bg-selected font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
          )}
        >
          <Icon aria-hidden className="size-[1.2rem]" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Props for {@link ReasoningLevelOptions}. */
export interface ReasoningLevelOptionsProps {
  readonly levels: readonly ReasoningLevel[];
  /** The level drawn with a check, or undefined for a model other than the selected one. */
  readonly checked: ReasoningLevel | undefined;
  /** The model's own default, tagged so the user can tell it from the level they last picked. */
  readonly defaultLevel?: ReasoningLevel;
  /** The listbox's accessible name. */
  readonly label: string;
  readonly onChoose: (level: ReasoningLevel) => void;
  /** Uses the picker list's 8px row inset instead of the menu's 12px, so a pane's rows line up with the list beside it. */
  readonly listInset?: boolean;
}

/**
 * Reasoning levels as a single-choice listbox: the arrow keys wrap, and Enter, Space or a click chooses. Focus enters
 * on the checked level, or the first when none is checked.
 */
export function ReasoningLevelOptions({ levels, checked, defaultLevel, label, onChoose, listInset = false }: ReasoningLevelOptionsProps) {
  const tabbable = checked !== undefined && levels.includes(checked) ? checked : levels[0];

  return (
    <div role="listbox" aria-label={label} onKeyDown={moveOptionFocus} className={cn("relative", MENU_LIST_CLASS, "p-0")}>
      <SlidingHighlight follow={{ pointer: '[role="option"]' }} />
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="option"
          aria-selected={level === checked}
          tabIndex={level === tabbable ? 0 : -1}
          onClick={() => onChoose(level)}
          className={cn(MENU_ROW_CLASS, listInset && "px-2")}
        >
          <MenuRowBody
            label={formatReasoningLabel(level)}
            trailing={
              level === defaultLevel ? (
                // The hidden comma keeps the name from running together as "HighDefault" while it still holds the visible text.
                <span className="text-caption text-muted"><span className="sr-only">,</span>{" Default"}</span>
              ) : undefined
            }
            checked={level === checked}
          />
        </button>
      ))}
    </div>
  );
}
