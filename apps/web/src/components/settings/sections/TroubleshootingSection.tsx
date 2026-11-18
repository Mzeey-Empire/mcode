import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Setting } from "../Setting";
import { settingsPage } from "../setting-def";
import { settingsValue } from "../setting-value";
import { SettingsGroup } from "../SettingsGroup";

function hardwareAccelerationBridge() {
  return typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
}

function HardwareAccelerationControl() {
  const bridge = hardwareAccelerationBridge();
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

  const needsRestart = runningEnabled !== null && runningEnabled !== savedEnabled;
  // The switch sits on the row's anchored edge in both layouts, so Restart appearing never moves it.
  return <div className="flex items-center gap-3 min-[80rem]:flex-row-reverse"><Switch aria-label="Hardware acceleration" checked={savedEnabled} onCheckedChange={(value) => void updateSettings({ graphics: { hardwareAcceleration: value } })} />{needsRestart && <Button variant="secondary" size="compact" onClick={() => void bridge?.relaunch?.()}>Restart</Button>}</div>;
}

function DiagnosticsRecordingControl() {
  const recording = useSettingsStore((s) => s.settings.diagnostics?.recording ?? true);
  const updateSettings = useSettingsStore((s) => s.update);
  return <Switch aria-label="Troubleshooting logs" checked={recording} onCheckedChange={(value) => void updateSettings({ diagnostics: { recording: value } })} />;
}

/** Settings on the Troubleshooting page. */
export const TROUBLESHOOTING = settingsPage("troubleshooting", {
  logs: {
    label: "Troubleshooting logs",
    hint: "Keeps a 7-day record of what your agents did, so you can find out why a thread got stuck. It stays on this computer and leaves out your messages and code.",
    synonyms: "logs log diagnostics debug record stuck trace recording",
    value: settingsValue((s) => s.diagnostics.recording, (recording) => ({ diagnostics: { recording } })),
    Control: DiagnosticsRecordingControl,
  },
  hardwareAcceleration: {
    label: "Hardware acceleration",
    hint: "Applies after Mcode restarts.",
    synonyms: "gpu graphics hardware acceleration rendering blank flicker blurry render",
    problems: "window blank flicker screen black terminal flicker terminal blank",
    value: settingsValue((s) => s.graphics.hardwareAcceleration, (hardwareAcceleration) => ({ graphics: { hardwareAcceleration } })),
    exists: () => {
      const bridge = hardwareAccelerationBridge();
      return Boolean(bridge?.getHardwareAcceleration && bridge.relaunch);
    },
    Control: HardwareAccelerationControl,
  },
});

/** Troubleshooting settings page: troubleshooting logs and hardware acceleration. */
export function TroubleshootingSection() {
  return (
    <SettingsGroup>
      <Setting def={TROUBLESHOOTING.logs} />
      <Setting def={TROUBLESHOOTING.hardwareAcceleration} />
    </SettingsGroup>
  );
}
