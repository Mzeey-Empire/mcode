import { useSettingsStore } from "@/stores/settingsStore";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { ProviderSection } from "./ProviderSection";

function CliUpdateChecksSetting() {
  const enabled = useSettingsStore((s) => s.settings.updates?.providerCliChecks ?? true);
  const update = useSettingsStore((s) => s.update);
  return (
    <SettingRow label="Check for CLI updates" hint="Asks the npm registry once a day for newer provider CLIs.">
      <Switch
        aria-label="Check for CLI updates"
        checked={enabled}
        onCheckedChange={(value) => void update({ updates: { providerCliChecks: value } })}
      />
    </SettingRow>
  );
}

/** Providers settings page: the provider list, then one shared CLI update check switch. */
export function ProvidersSection() {
  return (
    <div className="space-y-8">
      <ProviderSection />
      <SettingsGroup>
        <CliUpdateChecksSetting />
      </SettingsGroup>
    </div>
  );
}
