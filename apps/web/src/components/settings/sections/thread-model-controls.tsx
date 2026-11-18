import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useToastStore } from "@/stores/toastStore";
import {
  MODEL_PROVIDERS,
  getReasoningLevels,
  supportsThinkingToggle,
  pickProviderModelsForSettings,
  type ModelDefinition,
} from "@/lib/model-registry";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon } from "@/components/ui/provider-icon";
import type { ReasoningLevel, SettingsProviderId } from "@mcode/contracts/models/settings";
import type { ProviderAvailability } from "@mcode/contracts/providers/availability";
import { fastModeDefault, fastModeSettingProvider } from "@mcode/shared/fast-mode";
import { SettingRowFrame } from "../Setting";
import type { SettingRowProps } from "../setting-def";
import { SettingsSelectPicker, type SettingsPickOption } from "../SettingsSelectPicker";
import { chooseDefaultModel, chooseDefaultProvider } from "./thread-model-actions";

/** Display labels for provider-declared reasoning effort levels. */
const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

/** Hint shown under Fast mode when the default provider is Codex. */
const CODEX_FAST_MODE_HINT =
  "Sends OpenAI fast service tier on Codex turns when your CLI and account support it (often lower latency; billing follows OpenAI rules).";

/**
 * Builds a provider option for the Model / Utility Model pickers. A provider is
 * only rendered as disabled once its availability row has loaded and indicates it
 * is unusable (disabled by user, no adapter, or CLI missing). While availability
 * is still loading, the option stays selectable to avoid falsely blanking every
 * entry on first paint.
 */
function providerOptionTitle(comingSoon: boolean, avail: ProviderAvailability | undefined): string | undefined {
  return comingSoon
    ? "Coming soon"
    : avail == null
      ? undefined
      : !avail.enabled
        ? "Not enabled"
        : !avail.hasAdapter
          ? "Unavailable"
          : avail.cli.status === "not_found"
            ? avail.cli.message ?? "CLI not found"
            : undefined;
}

function buildProviderOption(
  p: (typeof MODEL_PROVIDERS)[number],
  avail: ProviderAvailability | undefined,
): { value: string; label: string; disabled: boolean; icon: ReactNode; title: string | undefined } {
  const unavailable =
    avail != null &&
    (!avail.enabled || !avail.hasAdapter || avail.cli.status === "not_found");
  const title = providerOptionTitle(p.comingSoon, avail);
  return {
    value: p.id,
    label: p.name,
    disabled: p.comingSoon || unavailable,
    icon: <ProviderIcon provider={p.id} size={12} />,
    title,
  };
}

function useProviderOptions(): readonly SettingsPickOption[] {
  const availabilityProviders = useProviderAvailabilityStore((s) => s.providers);
  return useMemo(() => {
    const availabilityById = new Map<string, ProviderAvailability>(availabilityProviders.map((row) => [row.id, row]));
    return MODEL_PROVIDERS.map((p) => buildProviderOption(p, availabilityById.get(p.id)));
  }, [availabilityProviders]);
}

function getProviderCliPath(
  providerId: string,
  cliPaths: { cursor: string; copilot: string },
): string {
  const cliPathByProvider = {
    cursor: cliPaths.cursor,
    copilot: cliPaths.copilot,
  };
  return cliPathByProvider[providerId as keyof typeof cliPathByProvider] ?? "";
}

function isModelStale(
  modelId: string,
  modelsLoading: boolean,
  catalogModels: readonly ModelDefinition[],
): boolean {
  return (
    !modelsLoading &&
    Boolean(modelId.trim()) &&
    catalogModels.length > 0 &&
    !catalogModels.some((model) => model.id === modelId)
  );
}

/**
 * Keeps a provider's model list fresh while a model picker is shown. Respects the store TTL
 * on mount and provider switches; forces a refetch only when the provider's CLI path changed
 * (Cursor/Copilot lists are path-dependent and the server invalidates its cache on that change).
 */
function useProviderModelsFetch(providerId: string, enabled: boolean): void {
  const fetchModels = useProviderModelsStore((s) => s.fetchModels);
  const cliPaths = useSettingsStore((s) => s.settings.provider.cli);
  const cliPath = getProviderCliPath(providerId, cliPaths);
  const lastCliPathByProvider = useRef<Record<string, string>>({});
  useEffect(() => {
    const prevCliPath = lastCliPathByProvider.current[providerId];
    lastCliPathByProvider.current[providerId] = cliPath;
    if (!enabled) return;
    void fetchModels(providerId, {
      force: prevCliPath !== undefined && prevCliPath !== cliPath,
    });
  }, [providerId, cliPath, enabled, fetchModels]);
}

/**
 * A provider's merged model list (live results over static catalog fallbacks) with a
 * saved id that disappeared from the catalog kept selectable under "Saved selection".
 */
function useModelChoices(providerId: string, savedId: string) {
  const provider = MODEL_PROVIDERS.find((p) => p.id === providerId);
  const dynamicModels = useProviderModelsStore((s) => s.models[providerId]);
  const loading = useProviderModelsStore((s) => s.loading[providerId] ?? false);
  const catalog = useMemo(
    () => pickProviderModelsForSettings(provider?.models ?? [], dynamicModels),
    [provider, dynamicModels],
  );
  const choices = useMemo(() => {
    if (savedId.trim() && !catalog.some((m) => m.id === savedId)) {
      const orphan: ModelDefinition = {
        id: savedId,
        label: `${savedId} (unlisted)`,
        providerId,
        group: "Saved selection",
      };
      return [orphan, ...catalog];
    }
    return catalog;
  }, [catalog, savedId, providerId]);
  return { catalog, choices, loading };
}

function modelOptionLabel(model: ModelDefinition): string {
  return model.multiplier != null && model.multiplier !== 1 ? `${model.label} (${model.multiplier}x)` : model.label;
}

/** Default provider for new threads. Switching resets the model and normalises reasoning through chooseDefaultProvider. */
export function DefaultProviderControl() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const options = useProviderOptions();
  return (
    <SettingsSelectPicker
      value={provider}
      searchPlaceholder="Search providers"
      onChange={(value) => void chooseDefaultProvider(value)}
      options={options}
      data-testid="settings-default-provider-trigger"
    />
  );
}

/**
 * Default model for new threads. Merges live `listProviderModels` results with static
 * catalog fallbacks (needed for Cursor, Copilot, and Claude API discovery). A stale saved
 * id stays selectable with a warning until the user changes it.
 */
export function DefaultModelControl() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  useProviderModelsFetch(provider, true);
  const { catalog, choices, loading } = useModelChoices(provider, modelId);

  const staleDefaultToastSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || catalog.length === 0) return;
    if (!modelId.trim()) return;
    if (catalog.some((m) => m.id === modelId)) return;
    const sig = `${provider}:${modelId}`;
    if (staleDefaultToastSigRef.current === sig) return;
    staleDefaultToastSigRef.current = sig;
    useToastStore.getState().show({
      kind: "info",
      title: "Saved model not in catalog",
      meta: `'${modelId}' is missing from the latest ${provider} model list. Pick another model in Settings.`,
    });
  }, [loading, catalog, modelId, provider]);

  const options = useMemo(
    () => choices.map((m) => ({ value: m.id, label: modelOptionLabel(m), group: m.group })),
    [choices],
  );

  return (
    <div className="flex flex-col items-end gap-2">
      <SettingsSelectPicker
        value={modelId}
        onChange={(value) => void chooseDefaultModel(value, choices.find((m) => m.id === value))}
        options={options}
        searchPlaceholder="Search models"
        loading={loading}
        data-testid="settings-default-model-trigger"
      />
      {isModelStale(modelId, loading, catalog) && (
        <p className="max-w-xs text-right text-xs text-warning">
          This model is not in the current catalog. Sending messages may fail until you choose a listed model.
        </p>
      )}
    </div>
  );
}

/** True when the default model declares reasoning levels. */
export function useReasoningApplies(): boolean {
  return useSettingsStore((s) => getReasoningLevels(s.settings.model.defaults.provider, s.settings.model.defaults.id).length > 0);
}

/** Reasoning effort row; its hint names the default provider, so the row draws it. */
export function ReasoningRow({ def, variant }: SettingRowProps) {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const update = useSettingsStore((s) => s.update);
  const options = useMemo(
    () => getReasoningLevels(provider, modelId).map((level) => ({ value: level, label: REASONING_LEVEL_LABELS[level] ?? level })),
    [provider, modelId],
  );
  const providerName = MODEL_PROVIDERS.find((p) => p.id === provider)?.name ?? provider;
  return (
    <SettingRowFrame def={def} variant={variant} hint={`Reasoning effort for ${providerName} models.`}>
      <SegmentedControl options={options} value={reasoning} onChange={(value) => update({ model: { defaults: { reasoning: value as ReasoningLevel } } })} />
    </SettingRowFrame>
  );
}

/** True when the default provider has a fast mode setting. */
export function useFastModeApplies(): boolean {
  return useSettingsStore((s) => fastModeSettingProvider(s.settings.model.defaults.provider) !== null);
}

/** Fast mode row; only Codex carries a hint, so the row draws it. Writes to the default provider's own setting. */
export function FastModeRow({ def, variant }: SettingRowProps) {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const fastMode = useSettingsStore((s) => fastModeDefault(s.settings, provider));
  const update = useSettingsStore((s) => s.update);
  const fastModeProvider = fastModeSettingProvider(provider);
  return (
    <SettingRowFrame def={def} variant={variant} hint={fastModeProvider === "codex" ? CODEX_FAST_MODE_HINT : undefined}>
      <Switch
        aria-label="Fast mode"
        checked={fastMode}
        onCheckedChange={(value) => {
          if (fastModeProvider) void update({ provider: { [fastModeProvider]: { fastMode: value } } });
        }}
      />
    </SettingRowFrame>
  );
}

/** True when the default model has a thinking toggle (Claude Haiku). */
export function useThinkingApplies(): boolean {
  return useSettingsStore((s) => s.settings.model.defaults.provider === "claude" && supportsThinkingToggle(s.settings.model.defaults.id));
}

/** Extended thinking switch for models without effort tiers. */
export function ThinkingControl() {
  const thinking = useSettingsStore((s) => s.settings.model.defaults.thinking);
  const update = useSettingsStore((s) => s.update);
  return (
    <SegmentedControl
      options={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ]}
      value={thinking ? "on" : "off"}
      onChange={(value) => update({ model: { defaults: { thinking: value === "on" } } })}
    />
  );
}

/** Provider for small tasks; Auto inherits the default provider. Changing it clears the utility model. */
export function UtilityProviderControl() {
  const utilityProvider = useSettingsStore((s) => s.settings.model.utility.provider);
  const update = useSettingsStore((s) => s.update);
  const providerOptions = useProviderOptions();
  const options = useMemo(
    () => [
      {
        value: "",
        label: "Auto",
        disabled: false,
        icon: <Sparkles size={12} className="text-muted" aria-hidden />,
        title: "Use the default provider above",
      },
      ...providerOptions,
    ],
    [providerOptions],
  );
  return (
    <SettingsSelectPicker
      value={utilityProvider}
      searchPlaceholder="Search providers"
      onChange={(value) => void update({ model: { utility: { provider: value as SettingsProviderId | "", id: "" } } })}
      options={options}
      data-testid="settings-utility-provider-trigger"
    />
  );
}

/** Model for small tasks; shows Auto until a utility provider is chosen. */
export function UtilityModelControl() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const utilityProvider = useSettingsStore((s) => s.settings.model.utility.provider);
  const utilityModelId = useSettingsStore((s) => s.settings.model.utility.id);
  const update = useSettingsStore((s) => s.update);
  const effectiveProvider = utilityProvider || provider;
  useProviderModelsFetch(effectiveProvider, Boolean(utilityProvider));
  const { choices, loading } = useModelChoices(effectiveProvider, utilityModelId);
  const options = useMemo(
    () => [
      { value: "", label: "Auto", group: undefined },
      ...choices.map((m) => ({ value: m.id, label: modelOptionLabel(m), group: m.group })),
    ],
    [choices],
  );

  if (!utilityProvider) {
    return (
      <div className="flex h-8 min-w-[220px] max-w-[280px] items-center rounded-[min(var(--radius-md),12px)] border border-control-border bg-background px-2.5 text-xs text-muted select-none">
        Auto
      </div>
    );
  }
  return (
    <SettingsSelectPicker
      value={utilityModelId}
      onChange={(value) => void update({ model: { utility: { id: value } } })}
      options={options}
      emptyTriggerLabel="Auto"
      searchPlaceholder="Search utility models"
      loading={loading}
      data-testid="settings-utility-model-trigger"
    />
  );
}
