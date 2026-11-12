import { Zap } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { useComposerAccess, type ComposerAccessInput } from "../controls/ComposerAccessControls";
import { isFastModeOn, persistReasoningLevel, type ComposerModelPreferenceDefaults } from "../controls/ComposerModelPreferences";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import { ModelPickerFooter } from "./ModelPickerFooter";

/** Props for {@link ComposerCapsuleSplit}. */
export interface ComposerCapsuleSplitProps extends ComposerAccessInput {
  /** The composer capsule. The picker opens 8px above its right edge, covering any tray, so a tray never moves it. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly defaults: ComposerModelPreferenceDefaults;
  readonly reasoningLevels: ReasoningLevel[];
  /** Started thread: model changes stay within its provider. */
  readonly isProviderLocked: boolean;
  /** Controls that share the pill after the model part, outside its hover fill: the context label and Send. */
  readonly children?: ReactNode;
}

/** Closes the user made from inside the capsule hand focus straight back to the part; an outside click or Tab keeps its own target. */
const REFOCUS_REASONS: ReadonlySet<string> = new Set(["escape-key", "trigger-press", "imperative-action"]);

// Wider than other pickers to fit the provider rail and the reasoning pane beside the model list. The picker draws its
// own edges, so the panel has no padding. Below 552px the composer, 32px narrower than the window, is narrower than
// 488px plus its insets, so the picker takes the composer's width and both its edges meet the composer's.
// A column, so when the room above the capsule runs short the picker's body shrinks and scrolls while its footer stays whole.
const POPUP_CLASS = cn(PICKER_PANEL_CLASS, "flex w-[48.8rem] flex-col p-0 max-[552px]:w-[calc(100vw-3.2rem)] max-h-(--available-height)");

// The open part takes the fill a step above the hover. A pressed part takes it from CSS on pointer-down, a frame before
// the popover's render can show it.
const PART_CLASS =
  "group/part relative inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-[9px] text-compact text-ink active:bg-button-secondary-hover aria-expanded:bg-button-secondary-hover focus-visible:outline-2 focus-visible:outline-focus @max-[680px]/capsule:px-[7px]";

/** The model part's label below the 680px tier, read against its provider's other models. */
function narrowLabelOf(model: SelectedModelPresentation, providerId: string): string {
  const prefix = model.displayProvider ? `${model.displayProvider.name} ` : "";
  return narrowModelLabel(model.shortLabel, listProviderModels(providerId).map((sibling) => sibling.label.replace(prefix, "")));
}

interface ModelPartFacts {
  readonly level: ReasoningLevel | null;
  readonly fast: boolean;
  /** The access label while the agent runs without approval prompts, which the part flags. */
  readonly unsupervised: string | null;
}

/** Names the model part with everything it shows: the model, its reasoning level, Fast, and access while it is unsupervised. */
function modelPartLabelOf(model: SelectedModelPresentation, { level, fast, unsupervised }: ModelPartFacts): string {
  const levelText = level ? `, ${formatReasoningLabel(level)} reasoning` : "";
  return `Model: ${model.shortLabel}${levelText}${fast ? ", Fast" : ""}${unsupervised ? `, ${unsupervised}` : ""}`;
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

/** The rule between the pill's parts. It paints under the hover fill, so the fill slides over it. */
export function CapsuleDivider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
}

/**
 * The composer's model part. Its picker sets the model and its reasoning level together, and its footer holds the
 * selected model's options and the turn's access, which change in place. Picking a model or a level closes the picker.
 */
export function ComposerCapsuleSplit(props: ComposerCapsuleSplitProps) {
  const { anchorRef, selection, defaults, reasoningLevels, isProviderLocked, onSelectionChange } = props;
  const [open, setOpen] = useState(false);
  // The search and the provider tab start over on each open.
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<string | null>(null);
  const actionsRef = useRef<PopoverRootActions | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const genie = useMemo((): PopoverMotion => ({ kind: "genie", origin: () => triggerRef.current }), []);
  const access = useComposerAccess(props);
  const unsupervised = selection.permissionMode === PERMISSION_MODES.FULL;
  const model = getSelectedModelPresentation(selection.modelId, selection.provider);
  const fast = isFastModeOn(selection, defaults);
  const preferenceProps = {
    threadId: props.threadId,
    branchFromMessageId: props.branchFromMessageId,
    selection,
    defaults,
    onSelectionChange,
  };
  // Closing through the root, not the state, lets the popup pour back into the part.
  const close = () => actionsRef.current?.close();
  const modelReasoning = {
    current: selection.reasoning,
    onChoose: (modelId: string, provider: string, reasoning: ReasoningLevel) => {
      onSelectionChange({ modelId, provider, reasoning });
      persistReasoningLevel(preferenceProps, reasoning);
      close();
    },
  };
  const level = reasoningLevels.includes(selection.reasoning) ? selection.reasoning : null;
  const modelLabel = modelPartLabelOf(model, { level, fast, unsupervised: unsupervised ? access.selected.label : null });
  const AccessIcon = access.selected.icon;

  return (
    <div className="flex min-w-0 items-center rounded-full bg-panel p-0.5">
      <div className="relative flex min-w-0 items-center">
        <SlidingHighlight follow={{ pointer: "[data-capsule-part]" }} />
        <Popover
          open={open}
          motion={genie}
          actionsRef={actionsRef}
          onOpenChange={(next, details) => {
            if (next) {
              setQuery("");
              setTab(null);
            }
            setOpen(next);
            // At once, not when the popup unmounts, so focus is back on the part while the popup pours into it. The
            // part's tooltip stays disabled until this close renders, so focus handed back opens no tooltip over it.
            if (!next && REFOCUS_REASONS.has(details.reason)) triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <Tooltip disabled={open}>
            <TooltipTrigger
              render={
                <PopoverTrigger ref={triggerRef} data-capsule-part="model" aria-label={modelLabel} className={PART_CLASS}>
                  <ProviderIcon provider={model.iconProviderId} size={14} />
                  <span className="min-w-0 text-fade @max-[680px]/capsule:hidden">{model.shortLabel}</span>
                  <span className="hidden min-w-0 text-fade @max-[680px]/capsule:inline">{narrowLabelOf(model, selection.provider)}</span>
                  {level && (
                    // On the open part's stronger fill, muted drops below AA in dark, so the open label takes ink.
                    <span className="flex shrink-0 gap-1.5 text-muted group-aria-expanded/part:text-ink">
                      <span aria-hidden>·</span>
                      {formatReasoningLabel(level)}
                    </span>
                  )}
                  {fast && <Zap aria-hidden size={12} data-testid="composer-fast-mode-icon" className="shrink-0 text-muted group-aria-expanded/part:text-ink" />}
                  {unsupervised && <AccessIcon aria-hidden size={12} data-testid="composer-unsupervised-icon" className="shrink-0 text-warning" />}
                </PopoverTrigger>
              }
            />
            <TooltipContent>{modelLabel}</TooltipContent>
          </Tooltip>
          <PopoverContent
            ref={popupRef}
            anchor={anchorRef}
            side="top"
            align="end"
            sideOffset={8}
            // The provider rail precedes the search in the DOM, so the first tabbable element is a provider, not the search.
            initialFocus={() => popupRef.current?.querySelector<HTMLElement>('input[role="combobox"]') ?? true}
            finalFocus={false}
            role="dialog"
            aria-label="Choose model and provider"
            className={POPUP_CLASS}
          >
            <ModelPickerPanel
              selectedModelId={selection.modelId}
              selectedProviderId={selection.provider}
              providerLocked={isProviderLocked}
              query={query}
              onQueryChange={setQuery}
              tab={tab}
              onTabChange={setTab}
              onSelect={(modelId, providerId) => {
                onSelectionChange(modelPickPatch(selection, modelId, providerId));
                close();
              }}
              reasoning={modelReasoning}
              footer={<ModelPickerFooter {...preferenceProps} access={access} unsupervised={unsupervised} />}
            />
          </PopoverContent>
        </Popover>
      </div>
      {props.children}
    </div>
  );
}
