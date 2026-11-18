import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { MODEL_PROVIDERS, getReasoningLevels, supportsThinkingToggle } from "@/lib/model-registry";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { fastModeDefault, fastModeSettingProvider } from "@mcode/shared/fast-mode";
import { SettingRowFrame } from "../Setting";
import type { SettingRowProps } from "../setting-def";

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
