import { isTaskListToolName } from "@mcode/contracts";
import type { ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import { backgroundHeldToolIds } from "../narrative/background-held-tools";
import { isSubagentLaunchRecord } from "../narrative/narrative-builder-helpers";
import { collapseSubagentRecords } from "../narrative/subagent-lifecycle";
import type { NarrativeCounts, TurnSummary } from "../narrative/types";

interface PersistedTurnRecords {
  tools: readonly ToolCallRecord[];
  thoughts: readonly ThoughtSegmentRecord[];
}

/** Counts top-level steps and sub-agents from persisted narrative records. */
export function persistedTurnCounts(records: PersistedTurnRecords): NarrativeCounts {
  const topLevel = collapseSubagentRecords(records.tools)
    .filter((tool) => tool.parent_tool_call_id == null && !isTaskListToolName(tool.tool_name));
  return {
    steps: topLevel.length,
    thoughts: records.thoughts.filter((thought) => thought.kind !== "reasoning").length,
    subagents: topLevel.filter(isSubagentLaunchRecord).length,
  };
}

function parseTimestamp(value: string | null): number | null {
  const timestamp = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validTimestamps(values: readonly (string | null)[]): number[] {
  return values.map(parseTimestamp).filter((value): value is number => value !== null);
}

/**
 * Approximates turn wall time for legacy turns that have no canonical summary.
 * Narrative records only bound the work they recorded, so this can undercount.
 */
export function persistedTurnDurationMs(records: PersistedTurnRecords): number | null {
  // A background call and the steps under it keep running after the turn, so their ends are not the turn's.
  const outlivesTurn = backgroundHeldToolIds(records.tools.map((tool) => ({
    id: tool.id, parentId: tool.parent_tool_call_id, background: tool.background === true })));
  const starts = validTimestamps([
    ...records.tools.map((tool) => tool.started_at),
    ...records.thoughts.map((thought) => thought.started_at),
  ]);
  const ends = validTimestamps([
    ...records.tools.filter((tool) => !outlivesTurn.has(tool.id)).map((tool) => tool.completed_at),
    // Launching a background call is work the turn did, so a turn whose only record is that call still has an end.
    ...records.tools.filter((tool) => tool.background === true).map((tool) => tool.started_at),
    ...records.thoughts.map((thought) => thought.ended_at),
  ]);
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/** Returns the approval-review sentence for a turn, or undefined when full access skipped review. */
export function approvalReviewNote(approvalReview: TurnSummary["approvalReview"]): string | undefined {
  if (!approvalReview || approvalReview.reason === "full-access-bypasses-approval-review") return undefined;
  const { mode, reason } = approvalReview;
  if (reason === "experimental-api-enabled") return "Automatic approval review selected.";
  if (reason === "manual-requested") return "Manual approval selected.";
  if (mode === "manual") return "Automatic review unavailable. Manual approval applies.";
  return mode === "automatic" ? "Automatic approval review selected." : "Manual approval selected.";
}
