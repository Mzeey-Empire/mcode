import { SettingsGroup } from "../SettingsGroup";
import { CliUpdateChecksSetting, ProviderSection } from "./ProviderSection";

export { PROVIDERS } from "./ProviderSection";

/** Providers settings page: the provider list, then one shared CLI update check switch. */
export function ProvidersSection() {
  return (
    <div className="space-y-8">
      <ProviderSection />
      <SettingsGroup title="Updates">
        <CliUpdateChecksSetting />
      </SettingsGroup>
    </div>
  );
}
