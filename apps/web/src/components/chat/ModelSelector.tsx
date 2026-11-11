import { useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger, type PopoverMotion, type PopoverRootActions } from "@/components/ui/popover";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { cn } from "@/lib/utils";
import { getSelectedModelPresentation, ModelPickerPanel, type SelectedModelPresentation } from "./ModelPickerPanel";

interface ModelSelectorProps {
  selectedModelId: string;
  /**
   * Explicit provider ID for the selected model. Required when multiple
   * providers share the same model ID (e.g. "gpt-5.3-codex" exists in both
   * Codex and Copilot). Without this, the selector cannot determine which
   * provider's icon/label to show, and the wrong provider may be committed.
   */
  selectedProviderId?: string;
  /** Called with both the model ID and the provider it was selected from. */
  onSelect: (modelId: string, providerId: string) => void;
  /** Provider locked: can switch models within the same provider but not change provider (thread started) */
  providerLocked?: boolean;
  /** Muted summary after the model name, such as the reasoning level. */
  detail?: ReactNode;
  /** Settings for the selected model, shown under the catalog. */
  settings?: ReactNode;
  /** Replaces the selected-model button that opens the picker. */
  trigger?: ReactElement;
}

function ModelSelectorTrigger({
  iconProviderId,
  shortLabel,
  detail,
  ...buttonProps
}: Pick<SelectedModelPresentation, "iconProviderId" | "shortLabel"> & Omit<ComponentProps<typeof Button>, "children"> & {
  readonly detail: ReactNode;
}) {
  return (
    <Button
      {...buttonProps}
      variant="ghost"
      size="compact"
      data-testid="model-selector-trigger"
      className="min-w-0 max-w-full shrink px-2 text-ink"
    >
      <ProviderIcon provider={iconProviderId} size={16} />
      <span className="min-w-0 text-fade">{shortLabel}</span>
      {detail ? <span className="flex shrink-0 items-center gap-1 text-body-small text-muted">{detail}</span> : null}
      <ChevronDown aria-hidden className="size-3 text-muted" />
    </Button>
  );
}

/**
 * A standalone model picker: a trigger and a popover around {@link ModelPickerPanel}. A pick closes the popover. The
 * composer hosts the panel in its split capsule instead.
 */
export function ModelSelector({
  selectedModelId,
  selectedProviderId,
  onSelect,
  providerLocked,
  detail,
  settings,
  trigger: customTrigger,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const presentation = getSelectedModelPresentation(selectedModelId, selectedProviderId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const genieMotion = useMemo((): PopoverMotion => ({ kind: "genie", origin: () => triggerRef.current }), []);
  const popoverActions = useRef<PopoverRootActions | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        setOpen(next);
      }}
      motion={genieMotion}
      actionsRef={popoverActions}
    >
      <PopoverTrigger
        ref={triggerRef}
        render={
          customTrigger ?? <ModelSelectorTrigger iconProviderId={presentation.iconProviderId} shortLabel={presentation.shortLabel} detail={detail} />
        }
      />
      <PopoverContent
        ref={popupRef}
        // The provider rail precedes the search in the DOM, so the first tabbable element is a provider, not the search.
        initialFocus={() => popupRef.current?.querySelector<HTMLElement>('input[role="combobox"]') ?? true}
        role="dialog"
        aria-label="Choose model and provider"
        side="top"
        align="end"
        className={cn(PICKER_PANEL_CLASS, "max-h-(--available-height) overflow-y-auto")}
      >
        <ModelPickerPanel
          selectedModelId={selectedModelId}
          selectedProviderId={selectedProviderId}
          providerLocked={providerLocked}
          query={query}
          onQueryChange={setQuery}
          onSelect={(modelId, providerId) => {
            onSelect(modelId, providerId);
            // Closing through the root rather than `setOpen` lets the picker pour back into its trigger.
            popoverActions.current?.close();
          }}
          footer={settings}
        />
      </PopoverContent>
    </Popover>
  );
}
