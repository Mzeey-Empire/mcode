/**
 * Renders late hooks (Stop / SessionEnd / PreCompact) for a completed assistant
 * message. These hooks fire after the SDK result message and are persisted
 * separately from the pre-message narrative timeline. They render between the
 * assistant text bubble and the files-changed summary.
 */

import { useMemo } from "react";
import { useActiveThreadRecord } from "@/stores/thread-selectors";
import { HookRow } from "@/components/chat/narrative/HookRow";
import type { HookExecution } from "@/transport/types";
import type { HookExecutionRecord } from "@mcode/contracts";

/** Props for `PersistedLateHooks`. */
interface PersistedLateHooksProps {
  /** Assistant message id whose late stop hooks to render. */
  messageId: string;
}

/**
 * Adapts a persisted `HookExecutionRecord` to the volatile `HookExecution`
 * shape expected by `HookRow`. No live output is available for persisted hooks
 * so `outputLines` and `fullOutput` are empty arrays.
 */
function recordToExecution(record: HookExecutionRecord): HookExecution {
  return {
    hookName: record.hook_name,
    hookType: "stop",
    toolName: record.tool_name ?? undefined,
    status: "completed",
    outputLines: [],
    fullOutput: [],
    exitCode: 0,
    durationMs: record.duration_ms ?? undefined,
    didBlock: record.did_block,
    startedAt: Date.parse(record.started_at) || 0,
  };
}

/**
 * Renders Stop / SessionEnd / PreCompact hooks that were persisted after the
 * turn's narrative timeline was already finalised. Returns null when no such
 * hooks exist for this message so the virtualizer item occupies zero height.
 */
export function PersistedLateHooks({ messageId }: PersistedLateHooksProps) {
  const records = useActiveThreadRecord((r) => r.narrativeByMessage[messageId]);

  const lateHooks = useMemo<HookExecutionRecord[]>(() => {
    if (!records) return [];
    // Only hooks tagged "stop" are late hooks; "permission" hooks belong in
    // the pre-message narrative timeline rendered by PersistedNarrative.
    return records.hooks.filter((h) => h.phase === "stop");
  }, [records]);

  if (lateHooks.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {lateHooks.map((record, i) => (
        <HookRow key={`${record.hook_name}-${record.started_at}-${i}`} hook={recordToExecution(record)} />
      ))}
    </div>
  );
}
