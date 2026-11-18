import { useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { Setting, useSettingHit } from "../Setting";
import { settingsGroup, settingsPage } from "../setting-def";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSelectPicker, type SettingsPickOption } from "../SettingsSelectPicker";
import {
  DefaultModeRadios,
  DefaultModelPart,
  DefaultPermissionPart,
  SmallTaskModelPicker,
  ThreadDefaultsCapsule,
} from "./thread-defaults-capsule";
import {
  FastModeRow,
  ReasoningRow,
  ThinkingControl,
  useFastModeApplies,
  useReasoningApplies,
  useThinkingApplies,
} from "./thread-model-controls";

const RETENTION_PRESETS = [1, 3, 7, 14, 30] as const;
const NEVER = "never";

function daysLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** The presets and Never, plus a saved period outside them (set by hand or an older build), so it is never lost. */
function retentionOptions(saved: number | null): SettingsPickOption[] {
  const days = saved !== null && !(RETENTION_PRESETS as readonly number[]).includes(saved)
    ? [...RETENTION_PRESETS, saved].sort((x, y) => x - y)
    : RETENTION_PRESETS;
  return [...days.map((day) => ({ value: String(day), label: daysLabel(day) })), { value: NEVER, label: "Never" }];
}

function RetentionControl() {
  const retentionDays = useSettingsStore((state) => state.settings.thread.completion.retentionDays);
  const update = useSettingsStore((state) => state.update);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SettingsSelectPicker
        value={retentionDays === null ? NEVER : String(retentionDays)}
        options={retentionOptions(retentionDays)}
        searchPlaceholder="Search periods"
        onChange={async (value) => {
          const failure = await update({ thread: { completion: { retentionDays: value === NEVER ? null : Number(value) } } });
          setError(failure || null);
        }}
        data-testid="settings-retention-trigger"
      />
      {error ? <FieldError role="alert">{error}</FieldError> : null}
    </div>
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

const NEW_THREADS = settingsGroup("New threads start with");
const SMALL_TASKS = settingsGroup("Model for small tasks");
const CLEANUP = settingsGroup("Closing and cleanup");
const NO_REASONING = "Only for models that offer reasoning levels. Choose one as the default model.";

/** Settings on the Threads page. */
export const THREADS = settingsPage("threads", {
  model: {
    group: NEW_THREADS,
    label: "Provider and model",
    synonyms: "default model provider gpt codex claude cursor copilot opencode devin opus sonnet haiku luna llm ai agent fast speed priority tier",
    configKey: "model.defaults.id",
    Control: DefaultModelPart,
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
    label: "Mode",
    synonyms: "plan build interaction mode",
    configKey: "agent.defaults.mode",
    Control: DefaultModeRadios,
  },
  permission: {
    group: NEW_THREADS,
    label: "Permission",
    synonyms: "access approval approve ask full supervised yolo permissions dont ask prompts",
    configKey: "agent.defaults.permission",
    Control: DefaultPermissionPart,
  },
  fastMode: {
    group: NEW_THREADS,
    label: "Fast mode",
    synonyms: "fast speed priority service tier latency",
    when: { useApplies: useFastModeApplies, reason: "Only for providers that offer a fast tier. Choose one as the default provider.", anchor: "threads.model" },
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
  smallTaskModel: {
    group: SMALL_TASKS,
    label: "Commit messages, PR drafts and thread recaps",
    synonyms: "small tasks utility provider model commit message pr draft recap summary cheap",
    configKey: "model.utility.id",
    Control: SmallTaskModelPicker,
  },
  closeOnMerge: {
    group: CLEANUP,
    label: "Close threads when their PRs merge",
    hint: "Each thread can override this from its menu.",
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
    label: "Delete closed threads after",
    hint: "Changes apply to existing closed threads. A shorter period gives newly overdue threads 24 hours before cleanup.",
    synonyms: "retention delete deleted cleanup purge remove disappear lost gone keep history closed threads soon early never",
    problems: "threads deleted too soon threads disappear lost closed threads",
    configKey: "thread.completion.retentionDays",
    Control: RetentionControl,
  },
});

/** The model part stands for the model and the applicable settings it shows: reasoning, Fast and Thinking. */
const MODEL_PART_DEFS = [THREADS.model, THREADS.reasoning, THREADS.fastMode, THREADS.thinking];
const MODE_DEFS = [THREADS.mode];
const PERMISSION_DEFS = [THREADS.permission];

function NewThreadDefaults() {
  const covered = [
    useReasoningApplies() && THREADS.reasoning.id,
    useFastModeApplies() && THREADS.fastMode.id,
    useThinkingApplies() && THREADS.thinking.id,
  ].filter(Boolean).join(" ");
  return (
    <ThreadDefaultsCapsule
      modelHit={useSettingHit(MODEL_PART_DEFS)}
      modeHit={useSettingHit(MODE_DEFS)}
      permissionHit={useSettingHit(PERMISSION_DEFS)}
      modelCovers={covered}
    />
  );
}

/**
 * Threads settings page: what new threads start with, laid out as the composer's capsule, the model for small
 * tasks, and when closed threads move to Older or get deleted.
 */
export function ThreadsSection() {
  return (
    <div className="space-y-8">
      <SettingsGroup group={NEW_THREADS} aside="Also set from the composer's model picker">
        <NewThreadDefaults />
      </SettingsGroup>
      <SettingsGroup group={SMALL_TASKS}>
        <Setting def={THREADS.smallTaskModel} />
      </SettingsGroup>
      <SettingsGroup group={CLEANUP}>
        <Setting def={THREADS.closeOnMerge} />
        <Setting def={THREADS.olderAfter} />
        <Setting def={THREADS.retention} />
      </SettingsGroup>
    </div>
  );
}
