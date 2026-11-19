import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { openInAppIcon } from "@/components/chat/openInAppIcons";
import type { OpenInApp } from "@/transport/types";
import type { Theme } from "@mcode/contracts/models/settings";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Setting } from "../Setting";
import { settingsPage } from "../setting-def";
import { settingsValue } from "../setting-value";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSelectPicker, type SettingsPickOption } from "../SettingsSelectPicker";

/** Empty `defaultEditor` selects tier-3 auto-resolution (the "Auto" option). */
const AUTO_VALUE = "";

/**
 * Builds the picker options for the global default open-in app: an "Auto" entry
 * (empty value, tier-3 auto-resolution) first, then every installed app with its
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
  const options: SettingsPickOption[] = [
    {
      value: AUTO_VALUE,
      label: "Auto",
      disabled: false,
      icon: <Sparkles size={14} aria-hidden />,
      title: "Resolve to your highest-priority installed editor, then File Explorer",
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
    hint: "Color scheme for the interface.",
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
    hint: "New threads open in this app. Auto picks your highest-priority installed editor and falls back to File Explorer.",
    synonyms: "open in editor vscode cursor ide external app explorer",
    value: settingsValue((s) => s.externalApps.defaultEditor, (defaultEditor) => ({ externalApps: { defaultEditor } })),
    Control: DefaultOpenInAppControl,
  },
});

/** General settings page: theme, notifications, and the default open-in app. */
export function GeneralSection() {
  return (
    <SettingsGroup>
      <Setting def={GENERAL.theme} />
      <Setting def={GENERAL.notifications} />
      <Setting def={GENERAL.openIn} />
    </SettingsGroup>
  );
}
