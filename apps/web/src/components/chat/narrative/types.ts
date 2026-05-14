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
