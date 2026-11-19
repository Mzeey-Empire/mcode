import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { openInAppIcon } from "@/components/chat/openInAppIcons";
import { resolveDefaultOpenInApp } from "@/lib/resolveDefaultOpenInApp";
import type { OpenInApp } from "@/transport/types";
import type { Theme } from "@mcode/contracts/models/settings";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SEARCH_HIT_CLASS, Setting, useSettingHit } from "../Setting";
import { settingsPage } from "../setting-def";
import { settingsValue } from "../setting-value";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSelectPicker, type SettingsPickOption } from "../SettingsSelectPicker";
import { ThemeTiles } from "./ThemeTiles";

/** Empty `defaultEditor` selects tier-3 auto-resolution (the "Auto" option). */
const AUTO_VALUE = "";

/**
 * Builds the picker options for the global default open-in app: an "Auto" entry
 * (empty value, tier-3 auto-resolution) naming the app it resolves to, then every installed app with its
 * registry icon. A saved id that is no longer installed is appended as a
 * selectable "(not installed)" row so a stale default stays visible and clearable
 * instead of silently disappearing.
 *
 * @param apps - All registry apps with detection status, from {@link useOpenInApps}.
 * @param currentValue - The saved `externalApps.defaultEditor` value.
 * @returns Ordered options for {@link SettingsSelectPicker}.
 */
export function buildOpenInAppOptions(
  apps: readonly OpenInApp[],
  currentValue: string,
): SettingsPickOption[] {
  const installed = apps.filter((app) => app.detected);
  // Before the app list loads, Auto names nothing rather than guessing File Explorer.
  const autoApp = apps.length > 0 ? resolveDefaultOpenInApp(null, null, apps) : undefined;
  const options: SettingsPickOption[] = [
    {
      value: AUTO_VALUE,
      label: "Auto",
      detail: autoApp === undefined ? undefined : (apps.find((app) => app.id === autoApp)?.label ?? "File Explorer"),
      disabled: false,
    },
    ...installed.map((app) => ({
      value: app.id,
      label: app.label,
      disabled: false,
      icon: openInAppIcon(app.iconKey, 14),
    })),
  ];

  if (currentValue && !installed.some((app) => app.id === currentValue)) {
    options.push({
      value: currentValue,
      label: `${currentValue} (not installed)`,
      disabled: false,
      title: "This app was not detected on this system",
    });
  }

  return options;
}

function ThemeControl() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const update = useSettingsStore((s) => s.update);
  return (
    <SegmentedControl
      options={[
        { value: "system", label: "System" },
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
      ]}
      value={theme}
      onChange={(v) => update({ appearance: { theme: v as Theme } })}
    />
  );
}

function NotificationsControl() {
  const enabled = useSettingsStore((s) => s.settings.notifications.enabled);
  const update = useSettingsStore((s) => s.update);
  return <Switch aria-label="Notifications" checked={enabled} onCheckedChange={(v) => update({ notifications: { enabled: v } })} />;
}

function DefaultOpenInAppControl() {
  const defaultEditor = useSettingsStore((s) => s.settings.externalApps.defaultEditor);
  const update = useSettingsStore((s) => s.update);
  const apps = useOpenInApps();
  const options = useMemo(() => buildOpenInAppOptions(apps, defaultEditor), [apps, defaultEditor]);

  return (
    <SettingsSelectPicker
      value={defaultEditor}
      onChange={(v) => void update({ externalApps: { defaultEditor: v } })}
      options={options}
      searchPlaceholder="Search apps"
      data-testid="settings-default-open-in-trigger"
    />
  );
}

/** Settings on the General page. */
export const GENERAL = settingsPage("general", {
  theme: {
    label: "Theme",
    synonyms: "theme dark light mode appearance color colour scheme system",
    value: settingsValue((s) => s.appearance.theme, (theme) => ({ appearance: { theme } })),
    Control: ThemeControl,
  },
  notifications: {
    label: "Notifications",
    hint: "Notify when a thread finishes, fails or needs you while Mcode is in the background.",
    synonyms: "notifications notify alert toast sound desktop",
    value: settingsValue((s) => s.notifications.enabled, (enabled) => ({ notifications: { enabled } })),
    Control: NotificationsControl,
  },
  openIn: {
    label: "Default open-in app",
    hint: "Auto picks your highest-priority installed editor and falls back to File Explorer.",
    synonyms: "open in editor vscode cursor ide external app explorer",
    value: settingsValue((s) => s.externalApps.defaultEditor, (defaultEditor) => ({ externalApps: { defaultEditor } })),
    Control: DefaultOpenInAppControl,
  },
});

/** The Theme group's panel: the window previews, marked when search opens the Theme setting. */
function ThemePanel() {
  const hit = useSettingHit([GENERAL.theme]);
  return (
    <div ref={hit.ref} {...hit.attrs} data-setting-id={GENERAL.theme.id} className={SEARCH_HIT_CLASS}>
      <ThemeTiles />
    </div>
  );
}

/** General settings page: theme previews, then notifications and the default open-in app. */
export function GeneralSection() {
  return (
    <div className="space-y-8">
      <SettingsGroup title="Theme">
        <ThemePanel />
      </SettingsGroup>
      <SettingsGroup>
        <Setting def={GENERAL.notifications} />
        <Setting def={GENERAL.openIn} />
      </SettingsGroup>
    </div>
  );
}
