import { useRef, useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSettingsStore } from "@/stores/settingsStore";
import type { AgentDefaultMode } from "@mcode/contracts/models/settings";
import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSelectPicker } from "../SettingsSelectPicker";
import { ThreadModelSettings } from "./ThreadModelSettings";

const DEFAULT_RETENTION_DAYS = 3;

function RetentionDaysControl({
  retentionDays,
  getLastValidDays,
  setLastValidDays,
  onUpdate,
}: {
  retentionDays: number | null;
  getLastValidDays: () => number;
  setLastValidDays: (days: number) => void;
  onUpdate: (retentionDays: number | null) => void;
}) {
  const automaticDeletionDisabled = retentionDays === null;
  const [draft, setDraft] = useState(String(retentionDays ?? DEFAULT_RETENTION_DAYS));
  const [error, setError] = useState<string | null>(null);

  const commitDraft = () => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setError("Enter a whole number from 1 to 365.");
      return;
    }
    setLastValidDays(parsed);
    setDraft(String(parsed));
    setError(null);
    if (retentionDays !== parsed) onUpdate(parsed);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Closed thread retention days"
          aria-describedby={error ? "completed-thread-retention-error" : undefined}
          aria-invalid={error ? true : undefined}
          type="number"
          min={1}
          max={365}
          step={1}
          value={draft}
          disabled={automaticDeletionDisabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(String(getLastValidDays()));
              setError(null);
              event.currentTarget.blur();
            }
          }}
          className="w-20 font-mono tabular-nums"
        />
        <span className="text-sm text-muted">days</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="completed-thread-retention-never"
          checked={automaticDeletionDisabled}
          onCheckedChange={(checked) => {
            setError(null);
            if (checked) {
              if (retentionDays !== null) setLastValidDays(retentionDays);
              onUpdate(null);
              return;
            }
            const lastValidDays = getLastValidDays();
            setDraft(String(lastValidDays));
            onUpdate(lastValidDays);
          }}
        />
        <label
          htmlFor="completed-thread-retention-never"
          className="text-sm text-ink"
        >
          <span aria-hidden>Never</span>
          <span className="sr-only">Never delete closed threads automatically</span>
        </label>
      </div>
      {error ? (
        <FieldError id="completed-thread-retention-error" role="alert" className="basis-full">
          {error}
        </FieldError>
      ) : null}
    </div>
  );
}

function AgentDefaultRows() {
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const update = useSettingsStore((s) => s.update);

  return (
    <>
      <SettingRow label="Default mode" configKey="agent.defaults.mode" hint="Interaction mode for new sessions.">
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
          onChange={(v) => update({ agent: { defaults: { permission: v as "full" | "supervised" } } })}
        />
      </SettingRow>
    </>
  );
}

/**
 * Threads settings page: what new threads start with, the model for small tasks,
 * and when closed threads move to Older or get deleted.
 */
export function ThreadsSection() {
  return (
    <div>
      <SectionHeading>Threads</SectionHeading>
      <div className="space-y-8">
        <ThreadModelSettings agentRows={<AgentDefaultRows />} />
        <ThreadCleanupSettings />
      </div>
    </div>
  );
}

function ThreadCleanupSettings() {
  const completeOnPrMerge = useSettingsStore((state) => state.settings.thread.completion.completeOnPrMerge);
  const olderAfterDays = useSettingsStore((state) => state.settings.thread.olderAfterDays);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const retentionDays = useSettingsStore(
    (state) => state.settings.thread.completion.retentionDays,
  );
  const update = useSettingsStore((state) => state.update);
  const lastValidDays = useRef(retentionDays ?? DEFAULT_RETENTION_DAYS);

  const updateRetentionDays = (nextRetentionDays: number | null) => {
    void update({ thread: { completion: { retentionDays: nextRetentionDays } } });
  };
  const getLastValidDays = () => lastValidDays.current;
  const setLastValidDays = (days: number) => {
    lastValidDays.current = days;
  };

  return (
    <SettingsGroup title="Closing and cleanup">
      <SettingRow label="Close threads when their PRs merge" configKey="thread.completion.completeOnPrMerge">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            aria-label="Close threads when their PRs merge"
            checked={completeOnPrMerge}
            onCheckedChange={async (checked) => {
              const failure = await update({ thread: { completion: { completeOnPrMerge: checked } } });
              setMergeError(failure || null);
            }}
          />
          {mergeError ? <FieldError role="alert">{mergeError}</FieldError> : null}
        </div>
      </SettingRow>
      <SettingRow label="Threads move to Older after" configKey="thread.olderAfterDays">
        <div className="flex flex-wrap items-center gap-3">
          <SettingsSelectPicker
            value={String(olderAfterDays)}
            options={[
              { value: "null", label: "Never" },
              { value: "7", label: "7 days" },
              { value: "14", label: "14 days" },
              { value: "30", label: "30 days" },
            ]}
            onChange={async (value) => {
              const days = value === "null" ? null : Number(value);
              if (days !== null && days !== 7 && days !== 14 && days !== 30) return;
              const failure = await update({ thread: { olderAfterDays: days } });
              setOlderError(failure || null);
            }}
          />
          {olderError ? <FieldError role="alert">{olderError}</FieldError> : null}
        </div>
      </SettingRow>
      <SettingRow
        label="Closed thread retention"
        configKey="thread.completion.retentionDays"
        hint="Changes apply to existing closed threads. A shorter period gives newly overdue threads 24 hours before cleanup."
      >
        <RetentionDaysControl
          key={retentionDays ?? "disabled"}
          retentionDays={retentionDays}
          getLastValidDays={getLastValidDays}
          setLastValidDays={setLastValidDays}
          onUpdate={updateRetentionDays}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
