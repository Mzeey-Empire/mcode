import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Hammer, ListChecks, Sparkles, Zap } from "lucide-react";
import type { AgentDefaultMode, SettingsProviderId } from "@mcode/contracts/models/settings";
import { fastModeDefault, fastModeSettingProvider } from "@mcode/shared/fast-mode";
import { getSelectedModelPresentation, ModelPickerPanel, type ModelPickerLead, type ModelPickerReasoning } from "@/components/chat/ModelPickerPanel";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AccessOptionList } from "@/features/conversation/composer/controls/AccessOptionList";
import { useComposerAccess } from "@/features/conversation/composer/controls/ComposerAccessControls";
import { ComposerModelOptions } from "@/features/conversation/composer/controls/ComposerModelPreferences";
import { createDefaultComposerAgentSelection, type ComposerAgentSelection } from "@/features/conversation/composer/draft/composer-selection-state";
import { formatReasoningLabel } from "@/lib/format-model-label";
import { findProviderModel, getReasoningLevels, MODEL_PROVIDERS, pickProviderModelsForSettings } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { PERMISSION_MODES } from "@/transport";
import { SEARCH_HIT_CLASS, type SettingHit } from "../Setting";
import { chooseDefaultModel } from "./thread-model-actions";

const PART_CLASS =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-compact text-ink hover:bg-hover aria-expanded:bg-hover focus-visible:outline-2 focus-visible:outline-focus";

// Wide enough for the provider rail, the list and the reasoning pane, as the composer's picker.
const MODEL_POPUP_CLASS = cn(PICKER_PANEL_CLASS, "flex w-[48.8rem] max-w-[calc(100vw-3.2rem)] flex-col p-0 max-h-(--available-height)");
const SMALL_POPUP_CLASS = cn(PICKER_PANEL_CLASS, "flex w-[40rem] max-w-[calc(100vw-3.2rem)] flex-col p-0 max-h-(--available-height)");

const NO_HIT: SettingHit = { hitId: null, ref: () => {}, attrs: {} };

function providerName(providerId: string): string {
  return MODEL_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
}

/**
 * True when the loaded catalog lacks the saved default model, so sending may fail. Fetches the default provider's
 * models, and shows one info toast per stale provider and model.
 */
function useStaleDefaultModel(): boolean {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const dynamicModels = useProviderModelsStore((s) => s.models[provider]);
  const loading = useProviderModelsStore((s) => s.loading[provider] ?? false);
  const fetchModels = useProviderModelsStore((s) => s.fetchModels);
  // Until the first fetch settles, the catalog is the static list, which lacks newer models and would warn falsely.
  const [fetchedProvider, setFetchedProvider] = useState<string | null>(null);
  useEffect(() => {
    void fetchModels(provider).then(() => setFetchedProvider(provider));
  }, [provider, fetchModels]);
  const catalog = useMemo(
    () => pickProviderModelsForSettings(MODEL_PROVIDERS.find((p) => p.id === provider)?.models ?? [], dynamicModels),
    [provider, dynamicModels],
  );
  const stale = fetchedProvider === provider && !loading && modelId.trim() !== "" && catalog.length > 0 && !catalog.some((m) => m.id === modelId);

  const toastedRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = `${provider}:${modelId}`;
    if (!stale || toastedRef.current === signature) return;
    toastedRef.current = signature;
    useToastStore.getState().show({
      kind: "info",
      title: "Saved model not in catalog",
      meta: `'${modelId}' is missing from the latest ${provider} model list. Pick another model in Settings.`,
    });
  }, [stale, provider, modelId]);
  return stale;
}

function useDefaultsSelection(): { selection: ComposerAgentSelection; fastDefault: boolean } {
  const defaults = useSettingsStore((s) => s.settings.model.defaults);
  const agent = useSettingsStore((s) => s.settings.agent.defaults);
  const fastDefault = useSettingsStore((s) => fastModeDefault(s.settings, s.settings.model.defaults.provider));
  return {
    fastDefault,
    selection: {
      ...createDefaultComposerAgentSelection(),
      provider: defaults.provider,
      modelId: defaults.id,
      reasoning: defaults.reasoning,
      thinking: defaults.thinking,
      fastMode: null,
      permissionMode: agent.permission === "full" ? PERMISSION_MODES.FULL : PERMISSION_MODES.SUPERVISED,
    },
  };
}

function writeModelOptions(patch: Partial<ComposerAgentSelection>): void {
  const { settings, update } = useSettingsStore.getState();
  if (patch.thinking != null) void update({ model: { defaults: { thinking: patch.thinking } } });
  const fastProvider = fastModeSettingProvider(settings.model.defaults.provider);
  if (patch.fastMode != null && fastProvider) void update({ provider: { [fastProvider]: { fastMode: patch.fastMode } } });
}

function modelPartLabel(provider: string, model: string, level: string | null, fast: boolean): string {
  return `Model: ${provider} ${model}${level ? `, ${formatReasoningLabel(level)}` : ""}${fast ? ", Fast" : ""}`;
}

/**
 * The default model, its reasoning level and Fast as one pill, opening the composer's model picker with its
 * reasoning pane and the model's options, so one click picks a model and its level.
 */
export function DefaultModelPart({
  hit = NO_HIT,
  coveredIds,
  describedBy,
}: {
  readonly hit?: SettingHit;
  readonly coveredIds?: string;
  /** Id of a note about the model, such as the stale-model warning. */
  readonly describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { selection, fastDefault } = useDefaultsSelection();
  const { provider, modelId, reasoning } = selection;
  const model = getSelectedModelPresentation(modelId, provider);
  const level = getReasoningLevels(provider, modelId).includes(reasoning) ? reasoning : null;
  const fast = fastDefault && findProviderModel(provider, modelId)?.supportsFastMode === true;
  const label = modelPartLabel(providerName(provider), model.shortLabel, level, fast);
  const handleOpenChange = (next: boolean) => {
    if (next) setQuery("");
    setOpen(next);
  };
  const modelReasoning: ModelPickerReasoning = {
    current: reasoning,
    onChoose: (pickedModel, pickedProvider, pickedLevel) => {
      void chooseDefaultModel(pickedProvider, pickedModel, pickedLevel);
      setOpen(false);
    },
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        ref={hit.ref}
        {...hit.attrs}
        data-setting-id={coveredIds === undefined ? undefined : "threads.model"}
        data-setting-covers={coveredIds}
        aria-label={label}
        aria-describedby={describedBy}
        className={cn(PART_CLASS, SEARCH_HIT_CLASS)}
      >
        <ProviderIcon provider={model.iconProviderId} size={14} />
        <span className="min-w-0 text-fade">{model.shortLabel}</span>
        {level && <span className="shrink-0 text-muted">· {formatReasoningLabel(level)}</span>}
        {fast && (
          <span className="flex shrink-0 items-center gap-1 text-muted">
            · <Zap aria-hidden size={12} />
            Fast
          </span>
        )}
        <ChevronDown aria-hidden size={12} className="shrink-0 text-muted" />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={4} role="dialog" aria-label="Choose model and provider" className={MODEL_POPUP_CLASS}>
        <ModelPickerPanel
          selectedModelId={modelId}
          selectedProviderId={provider}
          query={query}
          onQueryChange={setQuery}
          onSelect={(pickedModel, pickedProvider) => {
            void chooseDefaultModel(pickedProvider, pickedModel);
            setOpen(false);
          }}
          reasoning={modelReasoning}
          footer={
            <ComposerModelOptions
              selection={selection}
              defaults={{ thinking: selection.thinking ?? undefined, fastDefault }}
              onSelectionChange={writeModelOptions}
              withOrchestration={false}
            />
          }
        />
      </PopoverContent>
    </Popover>
  );
}

/** Plan or Build for new threads, as a pill radio group with the composer's Plan icon. */
export function DefaultModeRadios({ hit = NO_HIT, drawn = false }: { readonly hit?: SettingHit; readonly drawn?: boolean }) {
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const update = useSettingsStore((s) => s.update);
  return (
    <div ref={hit.ref} {...hit.attrs} data-setting-id={drawn ? "threads.mode" : undefined} className={cn("rounded-full", SEARCH_HIT_CLASS)}>
      <SegmentedControl
        variant="pill"
        aria-label="Mode"
        options={[
          { value: "plan", label: "Plan", icon: <ListChecks aria-hidden size={14} /> },
          { value: "build", label: "Build", icon: <Hammer aria-hidden size={14} /> },
        ]}
        value={mode}
        onChange={(value) => void update({ agent: { defaults: { mode: value as AgentDefaultMode } } })}
      />
    </div>
  );
}

/**
 * The default permission with the composer's access labels and icons. The setting is one choice for every provider,
 * so it takes the generic list, not Devin's native modes, and only the two values the setting stores.
 */
export function DefaultPermissionPart({ hit = NO_HIT, drawn = false }: { readonly hit?: SettingHit; readonly drawn?: boolean }) {
  const [open, setOpen] = useState(false);
  const { selection } = useDefaultsSelection();
  const update = useSettingsStore((s) => s.update);
  const access = useComposerAccess({
    selection: { ...selection, provider: "" },
    permissionLocked: false,
    approvalReviewSupported: false,
    onSelectionChange: (patch) => {
      if (patch.permissionMode === undefined) return;
      void update({ agent: { defaults: { permission: patch.permissionMode === PERMISSION_MODES.FULL ? "full" : "supervised" } } });
    },
    onSelectionTouched: () => {},
  });
  const unsupervised = selection.permissionMode === PERMISSION_MODES.FULL;
  const Icon = access.selected.icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={hit.ref}
        {...hit.attrs}
        data-setting-id={drawn ? "threads.permission" : undefined}
        aria-label={`Permission: ${access.selected.label}`}
        className={cn(PART_CLASS, SEARCH_HIT_CLASS)}
      >
        <Icon
          aria-hidden
          size={14}
          data-testid={unsupervised ? "settings-unsupervised-icon" : undefined}
          className={cn("shrink-0", unsupervised && "text-warning")}
        />
        {access.selected.label}
        <ChevronDown aria-hidden size={12} className="shrink-0 text-muted" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" initialFocus={false} className="w-58 p-0">
        <AccessOptionList access={access} onChosen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function CapsuleDivider() {
  return <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />;
}

/** Props for {@link ThreadDefaultsCapsule}: each part's search hit and the setting ids the model part stands for. */
export interface ThreadDefaultsCapsuleProps {
  readonly modelHit: SettingHit;
  readonly modeHit: SettingHit;
  readonly permissionHit: SettingHit;
  /** Space-separated ids of the applicable settings the model part shows besides the model: reasoning, Fast, Thinking. */
  readonly modelCovers: string;
}

/** What new threads start with, laid out as the composer's capsule: model, mode, then permission at the end. */
export function ThreadDefaultsCapsule({ modelHit, modeHit, permissionHit, modelCovers }: ThreadDefaultsCapsuleProps) {
  const stale = useStaleDefaultModel();
  const warningId = useId();
  return (
    <div className="flex flex-col gap-2 p-3">
      <div role="group" aria-label="New threads start with" className="flex flex-wrap items-center gap-1 rounded-(--radius-composer) bg-background p-1.5">
        <DefaultModelPart hit={modelHit} coveredIds={modelCovers} describedBy={stale ? warningId : undefined} />
        <CapsuleDivider />
        <DefaultModeRadios hit={modeHit} drawn />
        <span className="flex-1" />
        <DefaultPermissionPart hit={permissionHit} drawn />
      </div>
      {stale && (
        <p id={warningId} className="px-1.5 text-caption text-warning">
          This model is not in the current catalog. Sending messages may fail until you choose a listed model.
        </p>
      )}
    </div>
  );
}

function SmallTaskLabel({ provider, modelId }: { readonly provider: string; readonly modelId: string }): ReactNode {
  if (!modelId) {
    return (
      <>
        <Sparkles aria-hidden size={12} className="shrink-0 text-muted" />
        <span>Auto</span>
      </>
    );
  }
  const model = getSelectedModelPresentation(modelId, provider || undefined);
  return (
    <>
      <ProviderIcon provider={model.iconProviderId} size={12} />
      <span className="min-w-0 text-fade">{model.shortLabel}</span>
    </>
  );
}

/**
 * The model for commit messages, PR drafts and recaps: the composer's model picker without a reasoning pane, with
 * Auto first. Auto saves an empty provider and model, which the server resolves; it does not report its choice.
 */
export function SmallTaskModelPicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const provider = useSettingsStore((s) => s.settings.model.utility.provider);
  const modelId = useSettingsStore((s) => s.settings.model.utility.id);
  const auto = !modelId;
  const choose = useCallback((next: { provider: SettingsProviderId | ""; id: string }) => {
    void useSettingsStore.getState().update({ model: { utility: next } });
    setOpen(false);
  }, []);
  const lead = useMemo(
    (): ModelPickerLead => ({ label: "Auto", selected: auto, onSelect: () => choose({ provider: "", id: "" }) }),
    [auto, choose],
  );
  const name = auto ? "Auto" : getSelectedModelPresentation(modelId, provider || undefined).shortLabel;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label={`Model for small tasks: ${name}`}
        className="inline-flex h-8 max-w-[28rem] min-w-0 items-center justify-between gap-1.5 rounded-full pr-2 pl-3 text-compact text-ink hover:bg-hover aria-expanded:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <SmallTaskLabel provider={provider} modelId={modelId} />
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={4} role="dialog" aria-label="Choose the model for small tasks" className={SMALL_POPUP_CLASS}>
        <ModelPickerPanel
          selectedModelId={modelId}
          selectedProviderId={auto ? undefined : provider || undefined}
          query={query}
          onQueryChange={setQuery}
          onSelect={(pickedModel, pickedProvider) => choose({ provider: pickedProvider as SettingsProviderId, id: pickedModel })}
          lead={lead}
          fill
        />
      </PopoverContent>
    </Popover>
  );
}
