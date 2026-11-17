import { MENU_LIST_CLASS, MENU_ROW_CLASS, MenuRowBody } from "@/components/ui/menu-row";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Brain, Network, Zap, type LucideIcon } from "lucide-react";
import { ORCHESTRATION_MODES } from "@mcode/contracts/models/enums";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { findProviderModel, supportsThinkingToggle } from "@/lib/model-registry";
import { TIER_LADDER } from "@mcode/shared/model-effort";
import { formatReasoningLabel } from "@/lib/format-model-label";
import { useThreadStore, type ThreadSettings } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { FastModeStatus } from "@mcode/contracts/models/fast-mode";
import { FAST_MODE_COOLING_COPY, fastModeBlockedReason, fastModeView, type FastModeView } from "./fast-mode-view";
import { resolveComposerCapabilities } from "../composer-capabilities";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import { moveOptionFocus } from "./AccessOptionList";

/** Defaults that model preferences use when no thread override exists. */
export interface ComposerModelPreferenceDefaults {
  thinking: boolean | undefined;
  /** The selected provider's global Fast choice. */
  fastDefault: boolean;
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
  thinking: boolean;
  fast: FastModeView;
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
  if (selection.fastMode === null) return defaults.fastDefault;
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
  status: FastModeStatus | undefined,
): ModelPreferenceState {
  const model = findProviderModel(selection.provider, selection.modelId);
  const hasThinking = supportsClaudeModelOption(selection.provider, selection.modelId, supportsThinkingToggle);
  const thinking = getThinking(selection, defaults);
  const fast = fastModeView({
    supported: model?.supportsFastMode === true,
    chosen: getFastMode(selection, defaults),
    status,
    modelId: selection.modelId,
  });
  return { hasThinking, thinking, fast };
}

/** The selected model's Fast view: the user's choice, qualified by the thread's last provider status. */
export function useFastModeView(
  threadId: string | undefined,
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): FastModeView {
  const status = useThreadRecord(threadId, (record) => record.fastStatus);
  return getModelPreferenceState(selection, defaults, status).fast;
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

interface FastOption {
  readonly on: boolean;
  readonly blockedReason: string | null;
  /** A tooltip for a Fast that stays choosable, such as while the provider cools it down. */
  readonly note: string | null;
  readonly set: (on: boolean) => void;
}

interface ModelOptionToggle {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly on: boolean;
  readonly set: (on: boolean) => void;
}

/** The selected model's options: Fast as its own speed choice, then the on/off modes the model offers. */
interface ModelOptions {
  readonly fast: FastOption | null;
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
    fast: state.fast.kind === "absent"
      ? null
      : {
          on: state.fast.kind === "on" || state.fast.kind === "cooling",
          blockedReason: fastModeBlockedReason(state.fast),
          note: state.fast.kind === "cooling" ? FAST_MODE_COOLING_COPY : null,
          // Matching the provider's default stores no override, so the thread keeps following the setting.
          set: (on) => change({ fastMode: on === actionProps.defaults.fastDefault ? null : on }),
        },
    toggles,
  };
}

const FAST_ICON = <Zap aria-hidden className="size-[1.2rem]" />;

function speedOptionsOf({ blockedReason, note }: FastOption): SegmentedOption[] {
  const fast: SegmentedOption = { value: "fast", label: "Fast", icon: FAST_ICON };
  if (blockedReason !== null) return [{ value: "standard", label: "Standard" }, { ...fast, disabled: true, title: blockedReason }];
  return [{ value: "standard", label: "Standard" }, note === null ? fast : { ...fast, title: note }];
}

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
  const status = useThreadRecord(threadId, (record) => record.fastStatus);
  const state = getModelPreferenceState(selection, defaults, status);
  const { fast, toggles } = modelOptionsOf(state, { threadId, branchFromMessageId, selection, defaults, onSelectionChange });
  if (!fast && toggles.length === 0) return null;

  return (
    <div role="group" aria-label="Model options" className="flex min-w-0 flex-wrap items-center gap-2 @max-[340px]/picker-footer:gap-1.5">
      {fast && (
        <SegmentedControl
          variant="pill"
          size="small"
          aria-label="Speed"
          options={speedOptionsOf(fast)}
          value={fast.on ? "fast" : "standard"}
          onChange={(value) => fast.set(value === "fast")}
        />
      )}
      {toggles.map(({ label, icon: Icon, on, set }) => (
        // Off, a mode rests as bare text like the access button beside it, so the footer carries one filled strip;
        // on, it takes the fill a chosen speed shows over its track, so "on" looks the same across the footer.
        <button
          key={label}
          type="button"
          aria-pressed={on}
          onClick={() => set(!on)}
          className={cn(
            "inline-flex h-[2.6rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption whitespace-nowrap transition-colors duration-(--duration-fast) ease-(--ease-standard)",
            FOCUS_RING_CLASS,
            on ? "bg-ink/[0.16] text-ink" : "text-muted hover:bg-hover hover:text-ink",
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

// Mounting fades in, so the Default tag and the check ease onto their new row when the pane moves to another model.
const FADE_IN_CLASS = "transition-opacity duration-(--duration-standard) ease-(--ease-standard) starting:opacity-0 motion-reduce:transition-none";

/**
 * Reasoning levels as a single-choice listbox: the arrow keys wrap, and Enter, Space or a click chooses. Focus enters
 * on the checked level, or the first when none is checked.
 *
 * Every level of the ladder stays mounted and the ones `levels` lacks fold shut, so when the pane moves to another
 * model the levels both share hold still and the rest fold in or out, instead of the whole list swapping in one frame.
 */
export function ReasoningLevelOptions({ levels, checked, defaultLevel, label, onChoose, listInset = false }: ReasoningLevelOptionsProps) {
  const tabbable = checked !== undefined && levels.includes(checked) ? checked : levels[0];

  return (
    <div role="listbox" aria-label={label} onKeyDown={moveOptionFocus} className={cn("relative", MENU_LIST_CLASS, "p-0")}>
      <SlidingHighlight follow={{ pointer: '[role="option"]' }} />
      {TIER_LADDER.map((level) => (
        <AnimatedCollapsible key={level} open={levels.includes(level)}>
          <button
            type="button"
            role="option"
            aria-selected={level === checked}
            tabIndex={level === tabbable ? 0 : -1}
            onClick={() => onChoose(level)}
            // The gap lives in the row, so a folded level leaves no gap behind. The check is the row's only icon.
            className={cn(MENU_ROW_CLASS, listInset && "mb-px px-2", "[&_svg]:transition-opacity [&_svg]:duration-(--duration-standard) [&_svg]:starting:opacity-0 motion-reduce:[&_svg]:transition-none")}
          >
            <MenuRowBody
              label={formatReasoningLabel(level)}
              trailing={
                level === defaultLevel ? (
                  // The hidden comma keeps the name from running together as "HighDefault" while it still holds the visible text.
                  <span className={cn("text-caption text-muted", FADE_IN_CLASS)}><span className="sr-only">,</span>{" Default"}</span>
                ) : undefined
              }
              checked={level === checked}
            />
          </button>
        </AnimatedCollapsible>
      ))}
    </div>
  );
}
