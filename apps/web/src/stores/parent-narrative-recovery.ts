import { ParentNarrativeRecoveryItemSchema, type AgentModelState } from "@mcode/contracts";
import { recordToHookExecution, recordToToolCall } from "@/features/conversation/narrative/build-persisted-narrative";
import type { ThreadRecord } from "./thread-record";

/** Restores an unfinished parent's semantic activity at the subscription boundary. */
export function recoverParentNarrative(threadId: string, state: AgentModelState): Partial<ThreadRecord> {
  const turn = Object.values(state.turns)
    .filter((candidate) => candidate.threadId === threadId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  if (!turn || turn.trigger.kind === "child" || turn.status !== "Running") return {};
  const items = Object.values(state.items)
    .filter((item) => item.turnId === turn.id && item.payload.projection === "narrativeRecovery")
    .map((item) => ParentNarrativeRecoveryItemSchema().parse(item.payload.narrative))
    .sort((left, right) => left.record.sort_order - right.record.sort_order);
  if (items.length === 0) return {};
  const tools = items.filter((item) => item.kind === "toolCall");
  const thoughts = items.filter((item) => item.kind === "narrationSegment");
  const hooks = items.filter((item) => item.kind === "hook");
  const streaming = thoughts.filter((item) => item.record.is_final_response === 1)
    .map((item) => item.record.text).join("");
  return {
    toolCalls: tools.map((item) => recordToToolCall(item.record)),
    thoughtSegments: thoughts.filter((item) => item.record.is_final_response !== 1).map(({ record }) => ({
      text: record.text, startedAt: Date.parse(record.started_at),
      ...(record.ended_at ? { endedAt: Date.parse(record.ended_at) } : {}),
      isExplicitNonFinal: record.is_final_response === 0 || record.ended_at !== null,
    })),
    hooks: hooks.map((item) => recordToHookExecution(item.record)),
    streaming, streamingPreview: streaming.slice(-200),
    agentStartTime: Date.parse(turn.startedAt ?? turn.createdAt),
  };
}
