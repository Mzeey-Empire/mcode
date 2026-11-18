import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SectionHeading } from "../SectionHeading";
import type { AgentDefaultMode } from "@mcode/contracts/models/settings";

/**
 * Agent defaults for new sessions.
 */
export function AgentSection() {
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Agent</SectionHeading>
      <div>
      <SettingRow
        label="Default mode"
        configKey="agent.defaults.mode"
        hint="Interaction mode for new sessions."
      >
        <SegmentedControl
          options={[
            { value: "plan", label: "Plan" },
            { value: "build", label: "Build" },
            { value: "agent", label: "Agent", disabled: true, title: "Coming soon" },
          ]}
          value={mode}
          onChange={(v) => update({ agent: { defaults: { mode: v as AgentDefaultMode } } })}
        />
      </SettingRow>

      <SettingRow
        label="Default permission"
        configKey="agent.defaults.permission"
        hint="Supervised requires approval before file writes."
      >
        <SegmentedControl
          options={[
            { value: "full", label: "Full" },
            { value: "supervised", label: "Supervised" },
          ]}
          value={permission}
          onChange={(v) =>
            update({ agent: { defaults: { permission: v as "full" | "supervised" } } })
          }
        />
      </SettingRow>

      </div>
    </div>
  );
}
