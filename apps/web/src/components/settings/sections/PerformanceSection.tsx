import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";

/**
 * Performance settings section. Exposes runtime-tunable knobs that affect
 * memory and latency trade-offs (currently: in-memory thread cache size).
 */
export function PerformanceSection() {
  const threadCacheSize = useSettingsStore((s) => s.settings.performance.threadCacheSize);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Performance</SectionHeading>
      <div>
        <SettingRow
          label="Thread cache size"
          configKey="performance.threadCacheSize"
          hint="Number of recently-visited threads kept in memory. Higher = faster thread switching, more memory."
        >
          <RangeControl
            min={1}
            max={25}
            step={1}
            value={threadCacheSize}
            onCommit={(v) => void update({ performance: { threadCacheSize: v } })}
            formatValue={(v) => `${v} thread${v === 1 ? "" : "s"}`}
          />
        </SettingRow>
      </div>
    </div>
  );
}
