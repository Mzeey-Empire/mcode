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
          hint="Keeps the last N threads in memory for instant switching. 10 is a good default for most workflows. Takes effect immediately."
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
        {threadCacheSize <= 3 && (
          <p className="text-xs text-amber-500/80 mt-2 px-0">
            At this size, most thread switches will reload from the server.
          </p>
        )}
      </div>
    </div>
  );
}
