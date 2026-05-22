import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { Switch } from "@/components/ui/switch";
import { SectionHeading } from "../SectionHeading";

/**
 * Notifications settings section: toggles for desktop notifications and
 * handoff pipeline fallback banners.
 */
export function NotificationsSection() {
  const enabled = useSettingsStore((s) => s.settings.notifications.enabled);
  const notifyOnLocalFallback = useSettingsStore(
    (s) => s.settings.chat?.handoff?.notifyOnLocalFallback ?? true,
  );
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Notifications</SectionHeading>
      <div>
      <SettingRow
        label="Notifications"
        configKey="notifications.enabled"
        hint="Show desktop notifications for agent events."
      >
        <Switch
          checked={enabled}
          onCheckedChange={(v) => update({ notifications: { enabled: v } })}
        />
      </SettingRow>
      <SettingRow
        label="Notify on local handoff fallback"
        configKey="chat.handoff.notifyOnLocalFallback"
        hint="Show a banner when a fork's handoff was produced by the local deterministic builder because your provider was unavailable. Disable for silent downgrades."
      >
        <Switch
          checked={notifyOnLocalFallback}
          onCheckedChange={(v) =>
            update({ chat: { handoff: { notifyOnLocalFallback: v } } })
          }
        />
      </SettingRow>
      </div>
    </div>
  );
}
