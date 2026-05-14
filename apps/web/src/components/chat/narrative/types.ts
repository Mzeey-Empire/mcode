import type { ToolCall, HookExecution } from "@/transport/types";

/** A segment of agent thinking text between tool calls. */
export interface ThoughtSegment {
  /** Accumulated textDelta content for this segment. */
  text: string;
  /** Epoch ms when the first textDelta for this segment arrived. */
  startedAt: number;
  /** Epoch ms when the segment ended (next toolUse or turnComplete). Undefined if still streaming. */
  endedAt?: number;
}

/** A group of consecutive completed tool calls between two thoughts. */
export interface ToolGroup {
  calls: readonly ToolCall[];
}

/** Discriminated union for items in the narrative flow. */
export type NarrativeItem =
  | { type: "thought"; segment: ThoughtSegment; isActive: boolean }
  | { type: "tool-group"; group: ToolGroup; hasError: boolean; hasCancelled: boolean }
  | { type: "hook"; hook: HookExecution }
  | { type: "subagent"; toolCall: ToolCall; children: readonly ToolCall[]; hooks: readonly HookExecution[] }
  | { type: "active-tool"; toolCall: ToolCall }
  | { type: "delta"; text: string };

/**
 * Aggregate counts for the timeline, derived during `buildNarrativeItems`.
 * Powers the per-turn footer that appears between the timeline and the final
 * assistant message when the agent is no longer running.
 */
export interface NarrativeCounts {
  /** Top-level non-Agent tool calls + completed Agent calls. */
  steps: number;
  /** Number of thought segments rendered inline (not counting the final delta). */
  thoughts: number;
  /** Number of top-level Agent tool calls. */
  subagents: number;
}

/** Return value of `buildNarrativeItems` — items plus aggregate counts. */
export interface NarrativeBuildResult {
  items: NarrativeItem[];
  counts: NarrativeCounts;
}
