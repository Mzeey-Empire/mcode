import { useMemo, type ReactNode } from "react";
import { ProviderSection } from "./ProviderSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import {
  MODEL_PROVIDERS,
  isMaxEffortModel,
  isXhighEffortModel,
  supportsEffortParameter,
  supportsUltrathink,
  supports1MContextWindow,
  supportsThinkingToggle,
  normalizeReasoningLevelForModel,
  getCodexReasoningLevels,
} from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { SectionHeading } from "../SectionHeading";
import { Switch } from "@/components/ui/switch";
import type { ContextWindowMode, ProviderAvailability, SettingsProviderId, ReasoningLevel } from "@mcode/contracts";
import { ChevronDown } from "lucide-react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "@/components/chat/ProviderIcons";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Providers with more models than this threshold use a Select dropdown instead of SegControl. */
const SEG_CONTROL_MAX_MODELS = 6;

/** Maps provider id to its brand icon component. */
const PROVIDER_ICONS: Record<string, ReactNode> = {
  claude: <ClaudeIcon size={12} />,
  codex: <CodexIcon size={12} />,
  copilot: <CopilotIcon size={12} />,
  cursor: <CursorProviderIcon size={12} />,
  opencode: <OpenCodeIcon size={12} />,
  gemini: <GeminiIcon size={12} />,
};


const REASONING_OPTIONS_BASE = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Codex reasoning effort labels mapped from SDK level names. */
const CODEX_REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

/**
 * Builds a provider option for the Model / Utility Model pickers. A provider is
 * only rendered as disabled once its availability row has loaded and indicates it
 * is unusable (disabled by user, no adapter, or CLI missing). While availability
 * is still loading, the option stays selectable to avoid falsely blanking every
 * entry on first paint.
 */
function buildProviderOption(
  p: (typeof MODEL_PROVIDERS)[number],
  avail: ProviderAvailability | undefined,
): { value: string; label: string; disabled: boolean; icon: ReactNode; title: string | undefined } {
  const unavailable =
    avail != null &&
    (!avail.enabled || !avail.hasAdapter || avail.cli.status === "not_found");
  const title = p.comingSoon
    ? "Coming soon"
    : avail == null
      ? undefined
      : !avail.enabled
        ? "Not enabled"
        : !avail.hasAdapter
          ? "Unavailable"
          : avail.cli.status === "not_found"
            ? "CLI not found"
            : undefined;
  return {
    value: p.id,
    label: p.name,
    disabled: p.comingSoon || unavailable,
    icon: PROVIDER_ICONS[p.id],
    title,
  };
}

/**
 * Model settings section: provider, default model, fallback model, reasoning effort,
 * utility model provider/model, diff summary toggle, and CLI paths.
 *
 * Model options update when the provider changes. Switching provider resets the default
 * model to the new provider's first model and clears the fallback. The reasoning level
 * is normalized down when the new model does not support the current tier.
 */
export function ModelSection() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const fallbackId = useSettingsStore((s) => s.settings.model.defaults.fallbackId);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const contextWindowMode = useSettingsStore(
    (s) => s.settings.model.defaults.contextWindow,
  );
  const thinking = useSettingsStore((s) => s.settings.model.defaults.thinking);
  const utilityProvider = useSettingsStore((s) => s.settings.model.utility.provider);
  const utilityModelId = useSettingsStore((s) => s.settings.model.utility.id);
  const diffSummaryEnabled = useSettingsStore((s) => s.settings.diffSummary.enabled);
  const update = useSettingsStore((s) => s.update);
  const availabilityProviders = useProviderAvailabilityStore((s) => s.providers);
  const availabilityById = useMemo(
    () => new Map<string, ProviderAvailability>(availabilityProviders.map((row) => [row.id, row])),
    [availabilityProviders],
  );

  const providerOptions = useMemo(
    () => MODEL_PROVIDERS.map((p) => buildProviderOption(p, availabilityById.get(p.id))),
    [availabilityById],
  );

  const utilityProviderOptions = useMemo(
    () => [
      { value: "", label: "Auto" },
      ...MODEL_PROVIDERS.filter((p) => p.supportsCompletion).map((p) =>
        buildProviderOption(p, availabilityById.get(p.id)),
      ),
    ],
    [availabilityById],
  );

  const activeProvider = MODEL_PROVIDERS.find((p) => p.id === provider);

  // Effective provider for utility model: explicit selection or inherit from default
  const utilityEffectiveProvider = MODEL_PROVIDERS.find(
    (p) => p.id === (utilityProvider || provider),
  );

  const utilityEffectiveId = utilityProvider || provider;
  const dynamicUtilityModels = useProviderModelsStore((s) => s.models[utilityEffectiveId]);

  const modelOptions = useMemo(
    () => (activeProvider?.models ?? []).map((m) => ({
      value: m.id,
      label: m.multiplier != null && m.multiplier !== 1 ? `${m.label} (${m.multiplier}x)` : m.label,
      group: m.group,
    })),
    [activeProvider],
  );

  const fallbackOptions = useMemo(
    () => [{ value: "", label: "Off", group: undefined }, ...modelOptions],
    [modelOptions],
  );

  // Utility model options: "Auto" (provider default) + all models for the effective provider.
  // Dynamic models from the store take priority; static registry is the fallback when the
  // store hasn't fetched yet (e.g. Copilot not connected).
  const utilityModelOptions = useMemo(
    () => [
      { value: "", label: "Auto" },
      ...(dynamicUtilityModels ?? utilityEffectiveProvider?.models ?? []).map((m) => ({
        value: m.id,
        label: m.label,
      })),
    ],
    [dynamicUtilityModels, utilityEffectiveProvider],
  );

  // Gate on provider so Copilot models that share IDs with Codex models
  // don't accidentally take the Codex reasoning branch.
  const codexLevels = useMemo(
    () => (provider === "codex" ? getCodexReasoningLevels(modelId) : null),
    [provider, modelId],
  );

  const reasoningOptions = useMemo(() => {
    if (codexLevels) {
      return codexLevels.map((level) => ({
        value: level,
        label: CODEX_REASONING_LABELS[level] ?? level,
      }));
    }
    if (provider === "copilot") {
      return REASONING_OPTIONS_BASE;
    }
    // Claude: correct tier order is Low, Medium, High, X-High, Max, Ultrathink.
    // Tiers above the model's ceiling are disabled.
    return [
      ...REASONING_OPTIONS_BASE,
      { value: "xhigh",      label: "X-High",     disabled: !isXhighEffortModel(modelId) },
      { value: "max",        label: "Max",        disabled: !isMaxEffortModel(modelId) },
      { value: "ultrathink", label: "Ultrathink", disabled: !supportsUltrathink(modelId) },
    ];
  }, [modelId, codexLevels, provider]);

  const reasoningHint = useMemo(() => {
    if (codexLevels) {
      return codexLevels.includes("xhigh")
        ? "Reasoning effort for Codex models. X-High is the maximum tier."
        : "Reasoning effort for Codex models.";
    }
    if (provider === "copilot") {
      return "Reasoning effort passed to the Copilot model. Not all models support all levels.";
    }
    return "Default reasoning level. Max and Ultrathink require Opus 4.7/4.6 or Sonnet 4.6. X-High requires Opus 4.7. Ultrathink prepends an explicit instruction to the prompt.";
  }, [codexLevels, provider]);

  const handleProviderChange = (v: string) => {
    const newProvider = MODEL_PROVIDERS.find((p) => p.id === v);
    const firstModel = newProvider?.models[0];
    let newReasoning: string = reasoning;
    if (firstModel) {
      const codexLevels = getCodexReasoningLevels(firstModel.id);
      if (codexLevels) {
        // Switching to Codex: reset to model default if current level isn't valid
        newReasoning = codexLevels.includes(reasoning as never) ? reasoning : "medium";
      } else {
        newReasoning = normalizeReasoningLevelForModel(firstModel.id, reasoning);
      }
    }
    void update({
      model: {
        defaults: {
          provider: v as SettingsProviderId,
          ...(firstModel && { id: firstModel.id, fallbackId: "" }),
          reasoning: newReasoning as ReasoningLevel,
        },
      },
    });
  };

  const handleModelChange = (v: string) => {
    const codexLevels = getCodexReasoningLevels(v);
    let newReasoning: string = reasoning;
    if (codexLevels) {
      // For Codex models: if the stored level isn't valid for this model, use its default
      if (!codexLevels.includes(reasoning as never)) {
        newReasoning = "medium";
      }
    } else {
      newReasoning = normalizeReasoningLevelForModel(v, reasoning);
    }
    void update({
      model: {
        defaults: {
          id: v,
          ...(newReasoning !== reasoning && { reasoning: newReasoning as ReasoningLevel }),
        },
      },
    });
  };

  return (
    <div>
      <ProviderSection />

      <div className="mt-8">
      <SectionHeading>Model</SectionHeading>
      <div>
      <SettingRow
        label="Provider"
        configKey="model.defaults.provider"
        hint="AI provider for new threads."
      >
        <SegControl options={providerOptions} value={provider} onChange={handleProviderChange} />
      </SettingRow>

      <SettingRow
        label="Default model"
        configKey="model.defaults.id"
        hint="New threads start with this model."
      >
        {modelOptions.length > SEG_CONTROL_MAX_MODELS ? (
          <Select value={modelId} onValueChange={(v) => v != null && handleModelChange(v)}>
            <SelectTrigger size="sm" className="w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.some((m) => m.group)
                ? (() => {
                    const groups = new Map<string, typeof modelOptions>();
                    for (const m of modelOptions) {
                      const g = m.group ?? "";
                      if (!groups.has(g)) groups.set(g, []);
                      groups.get(g)!.push(m);
                    }
                    return Array.from(groups.entries()).map(([g, items]) => (
                      <SelectGroup key={g}>
                        {g && <SelectLabel>{g}</SelectLabel>}
                        {items.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ));
                  })()
                : modelOptions.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        ) : (
          <SegControl options={modelOptions} value={modelId} onChange={handleModelChange} />
        )}
      </SettingRow>

      <SettingRow
        label="Fallback model"
        configKey="model.defaults.fallbackId"
        hint="Used when the primary model is unavailable. Off disables fallback."
      >
        {fallbackOptions.length > SEG_CONTROL_MAX_MODELS ? (
          <Select
            value={fallbackId}
            onValueChange={(v) => v != null && update({ model: { defaults: { fallbackId: v } } })}
          >
            <SelectTrigger size="sm" className="w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fallbackOptions.some((m) => m.group)
                ? (() => {
                    const groups = new Map<string, typeof fallbackOptions>();
                    for (const m of fallbackOptions) {
                      const g = m.group ?? "";
                      if (!groups.has(g)) groups.set(g, []);
                      groups.get(g)!.push(m);
                    }
                    return Array.from(groups.entries()).map(([g, items]) => (
                      <SelectGroup key={g}>
                        {g && <SelectLabel>{g}</SelectLabel>}
                        {items.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ));
                  })()
                : fallbackOptions.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        ) : (
          <SegControl
            options={fallbackOptions}
            value={fallbackId}
            onChange={(v) => update({ model: { defaults: { fallbackId: v } } })}
          />
        )}
      </SettingRow>

      {(provider !== "claude" || supportsEffortParameter(modelId)) && (
        <SettingRow
          label="Reasoning effort"
          configKey="model.defaults.reasoning"
          hint={reasoningHint}
        >
          <SegControl
            options={reasoningOptions}
            value={reasoning}
            onChange={(v) =>
              update({ model: { defaults: { reasoning: v as ReasoningLevel } } })
            }
          />
        </SettingRow>
      )}

      {provider === "claude" && (
        <SettingRow
          label="Context window"
          configKey="model.defaults.contextWindow"
          hint="200k is the standard window. 1M unlocks the extended beta window on Opus 4.7/4.6 and Sonnet 4.6."
        >
          <SegControl
            options={[
              { value: "200k", label: "200K" },
              { value: "1m",   label: "1M",   disabled: !supports1MContextWindow(modelId) },
            ]}
            value={contextWindowMode}
            onChange={(v) =>
              update({ model: { defaults: { contextWindow: v as ContextWindowMode } } })
            }
          />
        </SettingRow>
      )}

      {provider === "claude" && supportsThinkingToggle(modelId) && (
        <SettingRow
          label="Thinking"
          configKey="model.defaults.thinking"
          hint="Enable extended thinking for Haiku 4.5. Effort-tier models ignore this and use the reasoning level instead."
        >
          <SegControl
            options={[
              { value: "off", label: "Off" },
              { value: "on",  label: "On"  },
            ]}
            value={thinking ? "on" : "off"}
            onChange={(v) =>
              update({ model: { defaults: { thinking: v === "on" } } })
            }
          />
        </SettingRow>
      )}
      </div>
      </div>

      <div className="mt-8">
        <SectionHeading>Utility Model</SectionHeading>
        <div>
          <SettingRow
            label="Provider"
            configKey="model.utility.provider"
            hint="AI provider for lightweight tasks (PR drafts, diff summaries). Auto inherits from the default provider above."
          >
            <SegControl
              options={utilityProviderOptions}
              value={utilityProvider}
              onChange={(v) => void update({ model: { utility: { provider: v as SettingsProviderId | "", id: "" } } })}
            />
          </SettingRow>
          <SettingRow
            label="Model"
            configKey="model.utility.id"
            hint="Model for utility tasks. Auto selects a provider-appropriate cheap default."
          >
            {utilityProvider ? (
              <div className="relative inline-flex w-56">
                <select
                  value={utilityModelId}
                  onChange={(e) => void update({ model: { utility: { id: e.target.value } } })}
                  className="h-7 w-full appearance-none cursor-pointer rounded-[min(var(--radius-md),12px)] border border-input bg-background pl-2 pr-7 py-0.5 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none"
                >
                  {utilityModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            ) : (
              <div className="h-7 w-56 rounded-[min(var(--radius-md),12px)] border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground flex items-center select-none">
                Auto
              </div>
            )}
          </SettingRow>
        </div>
      </div>

      <div className="mt-8">
        <SectionHeading>AI Features</SectionHeading>
        <div>
          <SettingRow
            label="Diff summary"
            configKey="diffSummary.enabled"
            hint="Show an AI-generated Summary tab in the diff panel."
          >
            <Switch
              checked={diffSummaryEnabled}
              onCheckedChange={(v) => update({ diffSummary: { enabled: v } })}
            />
          </SettingRow>
        </div>
      </div>

    </div>
  );
}
