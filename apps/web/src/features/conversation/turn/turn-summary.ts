import type { ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import { collapseSubagentRecords } from "../narrative/subagent-lifecycle";
import type { NarrativeCounts, TurnSummary } from "../narrative/types";

interface PersistedTurnRecords {
  tools: readonly ToolCallRecord[];
  thoughts: readonly ThoughtSegmentRecord[];
}

/** Counts top-level steps and sub-agents from persisted narrative records. */
export function persistedTurnCounts(records: PersistedTurnRecords): NarrativeCounts {
  const topLevel = collapseSubagentRecords(records.tools)
    .filter((tool) => tool.parent_tool_call_id == null);
  return {
    steps: topLevel.length,
    thoughts: records.thoughts.length,
    subagents: topLevel.filter((tool) => tool.tool_name === "Agent").length,
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
  const starts = validTimestamps([
    ...records.tools.map((tool) => tool.started_at),
    ...records.thoughts.map((thought) => thought.started_at),
  ]);
  const ends = validTimestamps([
    ...records.tools.map((tool) => tool.completed_at),
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
