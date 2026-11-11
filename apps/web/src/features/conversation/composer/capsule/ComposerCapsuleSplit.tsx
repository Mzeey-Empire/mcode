import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { PERMISSION_MODES } from "@/transport";
import { getSelectedModelPresentation, ModelPickerPanel, type SelectedModelPresentation } from "@/components/chat/ModelPickerPanel";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger, type PopoverMotion, type PopoverRootActions } from "@/components/ui/popover";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatReasoningLabel, narrowModelLabel } from "@/lib/format-model-label";
import { findProviderModel, getReasoningLevels, listProviderModels } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { AccessOptionList } from "../controls/AccessOptionList";
import { useComposerAccess, type ComposerAccessInput } from "../controls/ComposerAccessControls";
import {
  ComposerModelPreferenceSettings,
  ComposerModelPreferenceSummary,
  hasModelPreferences,
  type ComposerModelPreferenceDefaults,
} from "../controls/ComposerModelPreferences";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import { CAPSULE_PARTS, partPopoverReducer, SWITCH_DWELL_MS, type CapsulePart, type PartPopoverState } from "./part-popover-group";

/** Props for {@link ComposerCapsuleSplit}. */
export interface ComposerCapsuleSplitProps extends ComposerAccessInput {
  /** The composer capsule. Every part's popover opens 8px above its right edge, covering any tray, so a tray never moves it. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly defaults: ComposerModelPreferenceDefaults;
  readonly reasoningLevels: ReasoningLevel[];
  /** Started thread: model changes stay within its provider. */
  readonly isProviderLocked: boolean;
  /** Controls that share the pill after the parts, outside their hover fill: the context label and Send. */
  readonly children?: ReactNode;
}

const POPUP_LABEL: Record<CapsulePart, string> = {
  model: "Choose model and provider",
  reasoning: "Model settings",
  access: "Access",
};

const CLOSED: PartPopoverState = { status: "closed" };

/** Closes the user made from inside the capsule hand focus straight back to the part; an outside click or Tab keeps its own target. */
const REFOCUS_REASONS: ReadonlySet<string> = new Set(["escape-key", "trigger-press", "imperative-action"]);

type OpenPartPopover = Extract<PartPopoverState, { status: "open" }>;

// The access list carries the menu's own 4px padding, so its popover adds none.
const POPUP_CLASS: Record<CapsulePart, string> = {
  model: cn(PICKER_PANEL_CLASS, "max-h-(--available-height) overflow-y-auto"),
  reasoning: "w-56 p-1",
  access: "w-58 p-0",
};

// The open part takes the fill a step above the hover, so it still reads as open with the pointer on another part.
const PART_CLASS =
  "relative inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-[9px] text-compact text-ink outline-none aria-expanded:bg-button-secondary-hover focus-visible:outline-2 focus-visible:outline-focus @max-[680px]/capsule:px-[7px]";

/** The model part's label below the 680px tier, read against its provider's other models. */
function narrowLabelOf(model: SelectedModelPresentation, providerId: string): string {
  const prefix = model.displayProvider ? `${model.displayProvider.name} ` : "";
  return narrowModelLabel(model.shortLabel, listProviderModels(providerId).map((sibling) => sibling.label.replace(prefix, "")));
}

function reasoningTipOf(levels: readonly ReasoningLevel[], current: ReasoningLevel): string {
  return levels.length > 0 ? `Reasoning: ${formatReasoningLabel(current)}` : POPUP_LABEL.reasoning;
}

function isCapsulePart(value: string | null | undefined): value is CapsulePart {
  return CAPSULE_PARTS.some((part) => part === value);
}

/**
 * Devin effort levels are part of the model id family; when the new model cannot express the current reasoning
 * level, snap to its declared default so the label and the wire id stay consistent.
 */
function modelPickPatch(
  selection: ComposerAgentSelection,
  modelId: string,
  provider: ComposerAgentSelection["provider"],
): Partial<ComposerAgentSelection> {
  const patch: Partial<ComposerAgentSelection> = { modelId, provider };
  if (provider !== "devin") return patch;
  const model = findProviderModel(provider, modelId);
  const levels = model?.supportedReasoningLevels;
  if (levels?.length && !levels.includes(selection.reasoning)) {
    patch.reasoning = (model?.defaultReasoningLevel ?? levels[0]) as ReasoningLevel;
  }
  return patch;
}

/**
 * Starts a {@link SWITCH_DWELL_MS} timer when a mouse or pen rests on a part; leaving clears it. One timer at a time;
 * the reducer decides whether the dwell means anything.
 */
function useDwell(onDwell: (part: CapsulePart) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  useEffect(() => clear, []);
  return (part: CapsulePart) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      clear();
      timer.current = setTimeout(() => onDwell(part), SWITCH_DWELL_MS);
    },
    onPointerLeave: clear,
  });
}

/** Where each body puts focus, in order of preference: the reasoning slider comes before the toggles that precede it. */
const MODEL_FOCUS: readonly string[] = ['input[role="combobox"]'];
const REASONING_FOCUS: readonly string[] = ['input[type="range"]', "button"];

/** Moves focus to the first of `selectors` found inside the body once it mounts, so a switch lands focus as an open does. */
function FocusOnMount({ selectors, children }: { readonly selectors: readonly string[]; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    const target = selectors.map((selector) => body?.querySelector<HTMLElement>(selector)).find(Boolean);
    if (!body || !target) return;
    target.focus();
    if (target instanceof HTMLInputElement && target.type === "text") {
      target.setSelectionRange(target.value.length, target.value.length);
    }
    if (target.ownerDocument.activeElement === target) return;
    // Base UI keeps the slider's thumb hidden until it has measured it, which settles only after this commit, and a
    // hidden input takes no focus. Focus waits on the popup until the next frame: left on the page, it would make the
    // popover pull focus back onto the popup a frame later, over the slider.
    body.closest<HTMLElement>('[data-slot="popover-content"]')?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectors]);
  return <div ref={ref} className="contents">{children}</div>;
}

/**
 * The reasoning label at the width of the model's widest level: every level sits in one grid cell and all but the
 * current one are invisible, so dragging the bar never resizes the capsule.
 */
function SteadyReasoningLabel({ levels, current }: { readonly levels: readonly ReasoningLevel[]; readonly current: ReasoningLevel }) {
  return (
    <span className="inline-grid justify-items-center text-muted" data-testid="capsule-reasoning-label">
      {levels.map((level) => (
        <span key={level} className={cn("col-start-1 row-start-1", level !== current && "invisible")} aria-hidden={level !== current || undefined}>
          {formatReasoningLabel(level)}
        </span>
      ))}
    </span>
  );
}

function ReasoningBars({ levels, current }: { readonly levels: readonly ReasoningLevel[]; readonly current: ReasoningLevel }) {
  const filled = levels.indexOf(current) + 1;
  const step = 16 / levels.length;
  return (
    <svg aria-hidden width={14} height={14} viewBox="0 0 18 16" className="hidden @max-[680px]/capsule:block" data-testid="capsule-reasoning-bars">
      {levels.map((level, index) => {
        const height = 4 + Math.round((index * 11) / Math.max(1, levels.length - 1));
        return (
          <rect
            key={level}
            x={1 + index * step}
            y={15 - height}
            width={step - 1.2}
            height={height}
            rx={1}
            className={index < filled ? "fill-ink" : "fill-muted/35"}
          />
        );
      })}
    </svg>
  );
}

/** The rule between the pill's parts. It paints under the hover fill, so the fill slides over it. */
export function CapsuleDivider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
}

/**
 * The composer's model, reasoning and access in one pill. Each part opens its own body in one shared popover spot;
 * with a popover open, resting on another part switches to it, and picking a model with reasoning levels chains to
 * reasoning. The body is keyed by part, so a switch remounts it and it focuses its own target.
 */
export function ComposerCapsuleSplit(props: ComposerCapsuleSplitProps) {
  const { anchorRef, selection, defaults, reasoningLevels, isProviderLocked, onSelectionChange } = props;
  const baseId = useId();
  const triggerIdOf = (part: CapsulePart) => `${baseId}-${part}`;
  const [handle] = useState(() => PopoverPrimitive.createHandle());
  const [state, dispatch] = useReducer(partPopoverReducer, CLOSED);
  const actionsRef = useRef<PopoverRootActions | null>(null);
  const triggers = useRef(new Map<CapsulePart, HTMLElement>());
  // The reducer closes at once, but the popup pours back into the part that was open, still showing its body.
  const lastOpenRef = useRef<OpenPartPopover | null>(null);
  if (state.status === "open") lastOpenRef.current = state;
  const shown = lastOpenRef.current;
  const genie = useMemo(
    (): PopoverMotion => ({ kind: "genie", origin: () => triggers.current.get(lastOpenRef.current?.part ?? "model") ?? null }),
    [],
  );
  const dwellProps = useDwell((part) => dispatch({ type: "dwell", part }));
  const access = useComposerAccess(props);
  const showReasoning = hasModelPreferences(selection, defaults, reasoningLevels);
  const model = getSelectedModelPresentation(selection.modelId, selection.provider);
  const settings = (
    <ComposerModelPreferenceSettings
      threadId={props.threadId}
      branchFromMessageId={props.branchFromMessageId}
      selection={selection}
      defaults={defaults}
      reasoningLevels={reasoningLevels}
      onSelectionChange={onSelectionChange}
    />
  );
  const pickModel = (modelId: string, providerId: string) => {
    onSelectionChange(modelPickPatch(selection, modelId, providerId));
    const reasoningAvailable = getReasoningLevels(providerId, modelId).length > 0;
    dispatch({ type: "modelPicked", reasoningAvailable });
    // Closing through the root, not the reducer, lets the popup pour back into the part.
    if (!reasoningAvailable) actionsRef.current?.close();
  };
  const AccessIcon = access.selected.icon;
  const part = (name: CapsulePart, label: string, tip: string, children: ReactNode) => (
    <Tooltip disabled={state.status === "open"}>
      <TooltipTrigger
        render={
          <PopoverTrigger
            handle={handle}
            id={triggerIdOf(name)}
            ref={(element: HTMLElement | null) => {
              if (element) triggers.current.set(name, element);
              else triggers.current.delete(name);
            }}
            data-capsule-part={name}
            aria-label={label}
            className={PART_CLASS}
            {...dwellProps(name)}
          >
            {children}
          </PopoverTrigger>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
  const modelLabel = `Model: ${model.shortLabel}`;
  const accessLabel = `Access mode: ${access.selected.label}`;
  const reasoningLabel = reasoningTipOf(reasoningLevels, selection.reasoning);
  const unsupervised = selection.permissionMode === PERMISSION_MODES.FULL;

  return (
    <div className="flex min-w-0 items-center rounded-full bg-panel p-0.5">
      <div role="group" aria-label="Agent settings" className="relative flex min-w-0 items-center">
        <SlidingHighlight follow={{ pointer: "[data-capsule-part]" }} />
        {part("model", modelLabel, modelLabel, (
          <>
            <ProviderIcon provider={model.iconProviderId} size={14} />
            <span className="min-w-0 text-fade @max-[680px]/capsule:hidden">{model.shortLabel}</span>
            <span className="hidden min-w-0 text-fade @max-[680px]/capsule:inline @max-[480px]/capsule:hidden">{narrowLabelOf(model, selection.provider)}</span>
          </>
        ))}
        {showReasoning && (
          <>
            <CapsuleDivider />
            {part("reasoning", reasoningLabel, reasoningLabel, reasoningLevels.length > 0
              ? (
                <>
                  <span className="contents @max-[680px]/capsule:hidden"><SteadyReasoningLabel levels={reasoningLevels} current={selection.reasoning} /></span>
                  <ReasoningBars levels={reasoningLevels} current={selection.reasoning} />
                </>
              )
              : <ComposerModelPreferenceSummary selection={selection} defaults={defaults} reasoningLevels={reasoningLevels} />)}
          </>
        )}
        <CapsuleDivider />
        {part("access", accessLabel, accessLabel, <AccessIcon size={16} className={unsupervised ? "text-warning" : "text-muted"} />)}
        <Popover
          handle={handle}
          open={state.status === "open"}
          triggerId={state.status === "open" ? triggerIdOf(state.part) : null}
          motion={genie}
          actionsRef={actionsRef}
          onOpenChange={(next, details) => {
            if (!next) {
              dispatch({ type: "dismiss" });
              // At once, not when the popup unmounts, so focus is back on the part while the popup pours into it. The
              // part's tooltip stays disabled until this close renders, so focus handed back opens no tooltip over it.
              if (state.status === "open" && REFOCUS_REASONS.has(details.reason)) {
                triggers.current.get(state.part)?.focus({ preventScroll: true });
              }
              return;
            }
            const opened = details.trigger?.getAttribute("data-capsule-part");
            if (isCapsulePart(opened)) dispatch({ type: "open", part: opened });
          }}
        >
          <PopoverContent
            anchor={anchorRef}
            side="top"
            align="end"
            sideOffset={8}
            initialFocus={false}
            finalFocus={false}
            role="dialog"
            aria-label={shown ? POPUP_LABEL[shown.part] : undefined}
            className={shown ? POPUP_CLASS[shown.part] : undefined}
          >
            {shown && {
              model: (
                <FocusOnMount key="model" selectors={MODEL_FOCUS}>
                  <ModelPickerPanel
                    selectedModelId={selection.modelId}
                    selectedProviderId={selection.provider}
                    providerLocked={isProviderLocked}
                    query={shown.modelQuery}
                    onQueryChange={(text) => dispatch({ type: "query", text })}
                    tab={shown.modelTab}
                    onTabChange={(tab) => dispatch({ type: "tab", tab })}
                    onSelect={pickModel}
                    footer={showReasoning ? settings : null}
                  />
                </FocusOnMount>
              ),
              reasoning: (
                <FocusOnMount key="reasoning" selectors={REASONING_FOCUS}>
                  {settings}
                </FocusOnMount>
              ),
              access: <AccessOptionList key="access" access={access} onChosen={() => actionsRef.current?.close()} />,
            }[shown.part]}
          </PopoverContent>
        </Popover>
      </div>
      {props.children}
    </div>
  );
}
