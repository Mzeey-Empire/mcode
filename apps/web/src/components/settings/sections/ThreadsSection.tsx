import { useRef, useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";
import { SettingsSelectPicker } from "../SettingsSelectPicker";

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
          aria-label="Completed thread retention days"
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
          <span className="sr-only">Never delete completed threads automatically</span>
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

/** Settings for completed-thread retention and automatic deletion. */
export function ThreadsSection() {
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
    <div>
      <SectionHeading>Threads</SectionHeading>
      <SettingRow label="Complete threads when their PRs merge" configKey="thread.completion.completeOnPrMerge">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            aria-label="Complete threads when their PRs merge"
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
        label="Completed thread retention"
        configKey="thread.completion.retentionDays"
        hint="Changes apply to existing completed threads. A shorter period gives newly overdue threads 24 hours before cleanup."
      >
        <RetentionDaysControl
          key={retentionDays ?? "disabled"}
          retentionDays={retentionDays}
          getLastValidDays={getLastValidDays}
          setLastValidDays={setLastValidDays}
          onUpdate={updateRetentionDays}
        />
      </SettingRow>
    </div>
  );
}
