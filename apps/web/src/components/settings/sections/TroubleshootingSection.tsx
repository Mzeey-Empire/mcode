import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";

function HardwareAccelerationSetting() {
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
  const savedEnabled = useSettingsStore((s) => s.settings.graphics?.hardwareAcceleration ?? false);
  const updateSettings = useSettingsStore((s) => s.update);
  const [runningEnabled, setRunningEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge?.getHardwareAcceleration?.().then(({ enabled }) => {
      if (!cancelled) setRunningEnabled(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge?.getHardwareAcceleration || !bridge.relaunch) return null;
  const needsRestart = runningEnabled !== null && runningEnabled !== savedEnabled;
  // The switch sits on the row's anchored edge in both layouts, so Restart appearing never moves it.
  return <SettingRow label="Hardware acceleration" hint="Applies after Mcode restarts."><div className="flex items-center gap-3 min-[80rem]:flex-row-reverse"><Switch aria-label="Hardware acceleration" checked={savedEnabled} onCheckedChange={(value) => void updateSettings({ graphics: { hardwareAcceleration: value } })} />{needsRestart && <Button variant="secondary" size="compact" onClick={() => void bridge.relaunch?.()}>Restart</Button>}</div></SettingRow>;
}

function DiagnosticsRecordingSetting() {
  const recording = useSettingsStore((s) => s.settings.diagnostics?.recording ?? true);
  const updateSettings = useSettingsStore((s) => s.update);
  return <SettingRow label="Troubleshooting logs" hint="Keeps a 7-day record of what your agents did, so you can find out why a thread got stuck. It stays on this computer and leaves out your messages and code."><Switch aria-label="Troubleshooting logs" checked={recording} onCheckedChange={(value) => void updateSettings({ diagnostics: { recording: value } })} /></SettingRow>;
}

/** Troubleshooting settings page: troubleshooting logs and hardware acceleration. */
export function TroubleshootingSection() {
  return (
    <div>
      <SectionHeading>Troubleshooting</SectionHeading>
      <DiagnosticsRecordingSetting />
      <HardwareAccelerationSetting />
    </div>
  );
}
