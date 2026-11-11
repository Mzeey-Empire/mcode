import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Zap } from "lucide-react";
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
import { findProviderModel, listProviderModels } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { AccessOptionList } from "../controls/AccessOptionList";
import { useComposerAccess, type ComposerAccessInput } from "../controls/ComposerAccessControls";
import {
  ComposerModelPreferenceSettings,
  isFastModeOn,
  persistReasoningLevel,
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
  access: "Access",
};

const CLOSED: PartPopoverState = { status: "closed" };

/** Closes the user made from inside the capsule hand focus straight back to the part; an outside click or Tab keeps its own target. */
const REFOCUS_REASONS: ReadonlySet<string> = new Set(["escape-key", "trigger-press", "imperative-action"]);

type OpenPartPopover = Extract<PartPopoverState, { status: "open" }>;

// The access list carries the menu's own 4px padding, so its popover adds none.
const POPUP_CLASS: Record<CapsulePart, string> = {
  // Wider than other pickers to fit the reasoning pane beside the model list.
  // Below 504px the composer, 32px narrower than the window, is narrower than 440px plus its insets, so the picker
  // takes the composer's width and both its edges meet the composer's instead of sitting a few pixels inside one.
  model: cn(PICKER_PANEL_CLASS, "w-[44rem] max-[504px]:w-[calc(100vw-3.2rem)] max-h-(--available-height) overflow-y-auto"),
  access: "w-58 p-0",
};

// The open part takes the fill a step above the hover, so it still reads as open with the pointer on another part.
const PART_CLASS =
  "group/part relative inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-[9px] text-compact text-ink aria-expanded:bg-button-secondary-hover focus-visible:outline-2 focus-visible:outline-focus @max-[680px]/capsule:px-[7px]";

/** The model part's label below the 680px tier, read against its provider's other models. */
function narrowLabelOf(model: SelectedModelPresentation, providerId: string): string {
  const prefix = model.displayProvider ? `${model.displayProvider.name} ` : "";
  return narrowModelLabel(model.shortLabel, listProviderModels(providerId).map((sibling) => sibling.label.replace(prefix, "")));
}

/** Names the model part with everything it shows: the model, its reasoning level, and Fast when it is on. */
function modelPartLabelOf(model: SelectedModelPresentation, levels: readonly ReasoningLevel[], current: ReasoningLevel, fast: boolean): string {
  const level = levels.includes(current) ? `, ${formatReasoningLabel(current)} reasoning` : "";
  return `Model: ${model.shortLabel}${level}${fast ? ", Fast" : ""}`;
}

function isCapsulePart(value: string | null | undefined): value is CapsulePart {
  return CAPSULE_PARTS.some((part) => part === value);
}

/**
 * Keeps the current reasoning level when the new model can express it, else snaps to the model's declared default (or
 * its first level), so the label, the wire id and the level the model runs at stay consistent.
 */
function modelPickPatch(
  selection: ComposerAgentSelection,
  modelId: string,
  provider: ComposerAgentSelection["provider"],
): Partial<ComposerAgentSelection> {
  const patch: Partial<ComposerAgentSelection> = { modelId, provider };
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

/** Where the model body puts focus, so a switch lands focus as an open does. */
const MODEL_FOCUS: readonly string[] = ['input[role="combobox"]'];

/** Moves focus to the first of `selectors` found inside the body once it mounts, so a switch lands focus as an open does. */
function FocusOnMount({ selectors, children }: { readonly selectors: readonly string[]; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    const target = selectors.map((selector) => body?.querySelector<HTMLElement>(selector)).find(Boolean);
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement && target.type === "text") {
      target.setSelectionRange(target.value.length, target.value.length);
    }
  }, [selectors]);
  return <div ref={ref} className="contents">{children}</div>;
}

/** The rule between the pill's parts. It paints under the hover fill, so the fill slides over it. */
export function CapsuleDivider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
}

/**
 * The composer's model and access in one pill. The model part shows the reasoning level too, and its picker sets both:
 * a level in the reasoning pane picks the model and level together. Each part opens its own body in one shared popover
 * spot; with a popover open, resting on another part switches to it. Picking a model or a level closes the popover; the
 * selected model's option switches, under its levels, change in place. The body is keyed by part, so a switch remounts
 * it and it focuses its own target.
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
  const model = getSelectedModelPresentation(selection.modelId, selection.provider);
  const fast = isFastModeOn(selection, defaults);
  const preferenceProps = {
    threadId: props.threadId,
    branchFromMessageId: props.branchFromMessageId,
    selection,
    defaults,
    onSelectionChange,
  };
  // Closing through the root, not the reducer, lets the popup pour back into the part.
  const close = () => actionsRef.current?.close();
  const pickModel = (modelId: string, providerId: string) => {
    onSelectionChange(modelPickPatch(selection, modelId, providerId));
    close();
  };
  const modelReasoning = {
    current: selection.reasoning,
    onChoose: (modelId: string, provider: string, reasoning: ReasoningLevel) => {
      onSelectionChange({ modelId, provider, reasoning });
      persistReasoningLevel(preferenceProps, reasoning);
      close();
    },
    // 10px on the right: the check glyph's ink ends 2px inside its box, so the switches end where the checks do.
    options: <ComposerModelPreferenceSettings {...preferenceProps} className="mt-1 border-t border-border pt-1 pr-2.5 pl-2" />,
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
  const modelLabel = modelPartLabelOf(model, reasoningLevels, selection.reasoning, fast);
  const accessLabel = `Access mode: ${access.selected.label}`;
  const unsupervised = selection.permissionMode === PERMISSION_MODES.FULL;

  return (
    <div className="flex min-w-0 items-center rounded-full bg-panel p-0.5">
      <div role="group" aria-label="Agent settings" className="relative flex min-w-0 items-center">
        <SlidingHighlight follow={{ pointer: "[data-capsule-part]" }} />
        {part("model", modelLabel, modelLabel, (
          <>
            <ProviderIcon provider={model.iconProviderId} size={14} />
            <span className="min-w-0 text-fade @max-[680px]/capsule:hidden">{model.shortLabel}</span>
            <span className="hidden min-w-0 text-fade @max-[680px]/capsule:inline">{narrowLabelOf(model, selection.provider)}</span>
            {reasoningLevels.includes(selection.reasoning) && (
              // On the open part's stronger fill, muted drops below AA in dark, so the open label takes ink.
              <span className="flex shrink-0 gap-1.5 text-muted group-aria-expanded/part:text-ink">
                <span aria-hidden>·</span>
                {formatReasoningLabel(selection.reasoning)}
              </span>
            )}
            {fast && <Zap aria-hidden size={12} data-testid="composer-fast-mode-icon" className="shrink-0 text-muted group-aria-expanded/part:text-ink" />}
          </>
        ))}
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
                    reasoning={modelReasoning}
                  />
                </FocusOnMount>
              ),
              access: <AccessOptionList key="access" access={access} onChosen={close} />,
            }[shown.part]}
          </PopoverContent>
        </Popover>
      </div>
      {props.children}
    </div>
  );
}
