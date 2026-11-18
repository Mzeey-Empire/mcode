import { useRef, useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSettingsStore } from "@/stores/settingsStore";
import type { AgentDefaultMode } from "@mcode/contracts/models/settings";
import { Setting } from "../Setting";
import { settingsGroup, settingsPage } from "../setting-def";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSelectPicker } from "../SettingsSelectPicker";
import {
  DefaultModelControl,
  DefaultProviderControl,
  FastModeRow,
  ReasoningRow,
  ThinkingControl,
  UtilityModelControl,
  UtilityProviderControl,
  useFastModeApplies,
  useReasoningApplies,
  useThinkingApplies,
} from "./thread-model-controls";

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

function RetentionControl() {
  const retentionDays = useSettingsStore((state) => state.settings.thread.completion.retentionDays);
  const update = useSettingsStore((state) => state.update);
  const lastValidDays = useRef(retentionDays ?? DEFAULT_RETENTION_DAYS);
  return (
    <RetentionDaysControl
      key={retentionDays ?? "disabled"}
      retentionDays={retentionDays}
      getLastValidDays={() => lastValidDays.current}
      setLastValidDays={(days) => {
        lastValidDays.current = days;
      }}
      onUpdate={(next) => void update({ thread: { completion: { retentionDays: next } } })}
    />
  );
}

function DefaultModeControl() {
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const update = useSettingsStore((s) => s.update);
  return (
    <SegmentedControl
      options={[
        { value: "plan", label: "Plan" },
        { value: "build", label: "Build" },
        { value: "agent", label: "Agent", disabled: true, title: "Coming soon" },
      ]}
      value={mode}
      onChange={(v) => update({ agent: { defaults: { mode: v as AgentDefaultMode } } })}
    />
  );
}

function DefaultPermissionControl() {
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const update = useSettingsStore((s) => s.update);
  return (
    <SegmentedControl
      options={[
        { value: "full", label: "Full" },
        { value: "supervised", label: "Supervised" },
      ]}
      value={permission}
      onChange={(v) => update({ agent: { defaults: { permission: v as "full" | "supervised" } } })}
    />
  );
}

function CloseOnMergeControl() {
  const completeOnPrMerge = useSettingsStore((state) => state.settings.thread.completion.completeOnPrMerge);
  const update = useSettingsStore((state) => state.update);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch
        aria-label="Close threads when their PRs merge"
        checked={completeOnPrMerge}
        onCheckedChange={async (checked) => {
          const failure = await update({ thread: { completion: { completeOnPrMerge: checked } } });
          setError(failure || null);
        }}
      />
      {error ? <FieldError role="alert">{error}</FieldError> : null}
    </div>
  );
}

function OlderAfterControl() {
  const olderAfterDays = useSettingsStore((state) => state.settings.thread.olderAfterDays);
  const update = useSettingsStore((state) => state.update);
  const [error, setError] = useState<string | null>(null);
  return (
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
          setError(failure || null);
        }}
      />
      {error ? <FieldError role="alert">{error}</FieldError> : null}
    </div>
  );
}

const NEW_THREADS = settingsGroup("New threads start with", "Defaults applied when you start a new thread.");
const SMALL_TASKS = settingsGroup("Model for small tasks", "Provider and model for lightweight tasks such as PR drafts.");
const CLEANUP = settingsGroup("Closing and cleanup");
const NO_REASONING = "Only for models that offer reasoning levels. Choose one as the default model.";

/** Settings on the Threads page. */
export const THREADS = settingsPage("threads", {
  provider: {
    group: NEW_THREADS,
    label: "Provider",
    hint: "AI provider for new threads.",
    synonyms: "default provider claude codex cursor copilot opencode devin llm ai agent",
    configKey: "model.defaults.provider",
    Control: DefaultProviderControl,
  },
  model: {
    group: NEW_THREADS,
    label: "Default model",
    hint: "New threads start with this model.",
    synonyms: "default model gpt opus sonnet haiku llm ai",
    configKey: "model.defaults.id",
    Control: DefaultModelControl,
  },
  reasoning: {
    group: NEW_THREADS,
    label: "Reasoning effort",
    synonyms: "thinking effort reasoning depth high low",
    configKey: "model.defaults.reasoning",
    when: { useApplies: useReasoningApplies, reason: NO_REASONING, anchor: "threads.model" },
    Row: ReasoningRow,
  },
  mode: {
    group: NEW_THREADS,
    label: "Default mode",
    hint: "Interaction mode for new sessions.",
    synonyms: "plan build interaction mode",
    configKey: "agent.defaults.mode",
    Control: DefaultModeControl,
  },
  permission: {
    group: NEW_THREADS,
    label: "Default permission",
    hint: "Supervised requires approval before file writes.",
    synonyms: "access approval approve ask full supervised yolo permissions dont ask prompts",
    configKey: "agent.defaults.permission",
    Control: DefaultPermissionControl,
  },
  fastMode: {
    group: NEW_THREADS,
    label: "Fast mode",
    synonyms: "fast speed priority service tier latency",
    when: { useApplies: useFastModeApplies, reason: "Only for providers that offer a fast tier. Choose one as the default provider.", anchor: "threads.provider" },
    Row: FastModeRow,
  },
  thinking: {
    group: NEW_THREADS,
    label: "Thinking",
    hint: "Enable extended thinking for Haiku 4.5. Effort-tier models ignore this and use the reasoning level instead.",
    synonyms: "extended thinking haiku",
    configKey: "model.defaults.thinking",
    when: { useApplies: useThinkingApplies, reason: "Only for Claude models with a thinking toggle, such as Haiku 4.5.", anchor: "threads.model" },
    Control: ThinkingControl,
  },
  utilityProvider: {
    group: SMALL_TASKS,
    label: "Provider",
    hint: "AI provider for lightweight tasks (PR drafts). Auto inherits from the default provider above.",
    synonyms: "small tasks utility provider commit message pr draft recap summary cheap",
    configKey: "model.utility.provider",
    Control: UtilityProviderControl,
  },
  utilityModel: {
    group: SMALL_TASKS,
    label: "Model",
    hint: "Model for utility tasks. Auto selects a provider-appropriate cheap default.",
    synonyms: "small tasks utility model commit message pr draft recap summary cheap",
    configKey: "model.utility.id",
    Control: UtilityModelControl,
  },
  closeOnMerge: {
    group: CLEANUP,
    label: "Close threads when their PRs merge",
    synonyms: "close merged pull request pr auto close archive",
    configKey: "thread.completion.completeOnPrMerge",
    Control: CloseOnMergeControl,
  },
  olderAfter: {
    group: CLEANUP,
    label: "Threads move to Older after",
    synonyms: "older stale sidebar age inactive",
    configKey: "thread.olderAfterDays",
    Control: OlderAfterControl,
  },
  retention: {
    group: CLEANUP,
    label: "Closed thread retention",
    hint: "Changes apply to existing closed threads. A shorter period gives newly overdue threads 24 hours before cleanup.",
    synonyms: "retention delete deleted cleanup purge remove disappear lost gone keep history closed threads soon early never",
    problems: "threads deleted too soon threads disappear lost closed threads",
    configKey: "thread.completion.retentionDays",
    Control: RetentionControl,
  },
});

/**
 * Threads settings page: what new threads start with, the model for small tasks,
 * and when closed threads move to Older or get deleted.
 */
export function ThreadsSection() {
  return (
    <div className="space-y-8">
      <SettingsGroup group={NEW_THREADS}>
        <Setting def={THREADS.provider} />
        <Setting def={THREADS.model} />
        <Setting def={THREADS.reasoning} />
        <Setting def={THREADS.mode} />
        <Setting def={THREADS.permission} />
        <Setting def={THREADS.fastMode} />
        <Setting def={THREADS.thinking} />
      </SettingsGroup>
      <SettingsGroup group={SMALL_TASKS}>
        <Setting def={THREADS.utilityProvider} />
        <Setting def={THREADS.utilityModel} />
      </SettingsGroup>
      <SettingsGroup group={CLEANUP}>
        <Setting def={THREADS.closeOnMerge} />
        <Setting def={THREADS.olderAfter} />
        <Setting def={THREADS.retention} />
      </SettingsGroup>
    </div>
  );
}
