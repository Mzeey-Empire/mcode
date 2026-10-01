import { MessageSchema, ParentNarrativeRecoveryItemSchema, type AgentItem, type AgentModelState, type AgentTurn, type Message, type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { recordToHookExecution, recordToToolCall } from "@/features/conversation/narrative/build-persisted-narrative";
import type { ThreadRecord } from "./thread-record";
import { getCanonicalRuntimeTurn } from "./thread-lifecycle";

/** Restores a parent's active narrative or terminal response at the subscription boundary. */
export function recoverParentNarrative(threadId: string, state: AgentModelState, record?: ThreadRecord): Partial<ThreadRecord> {
  const turn = recoverableTurn(threadId, state, record);
  if (!turn) return {};
  const items = Object.values(state.items)
    .filter((item) => item.turnId === turn.id)
    .flatMap(parentNarrativeRecord)
    .sort((left, right) => left.record.sort_order - right.record.sort_order);
  if (items.length === 0 && !record) return {};
  const narrative = recoveredNarrative(turn, items);
  return {
    ...(items.length > 0 ? narrative.patch : {}),
    ...(narrative.terminal && record ? recoveredTerminalResponse(threadId, turn, state, record, narrative.streaming) : {}),
  };
}

function parentNarrativeRecord(item: AgentItem): ParentNarrativeRecoveryItem[] {
  const projection = item.payload.projection;
  if (projection === "narrativeRecovery") return [ParentNarrativeRecoveryItemSchema().parse(item.payload.narrative)];
  if (projection === "toolCall" || projection === "narrationSegment" || projection === "hook") {
    return [ParentNarrativeRecoveryItemSchema().parse({ kind: projection, record: item.payload.record })];
  }
  return [];
}

function recoverableTurn(threadId: string, state: AgentModelState, record?: ThreadRecord): AgentTurn | undefined {
  const turn = Object.values(state.turns)
    .filter((candidate) => candidate.threadId === threadId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  if (!turn || turn.trigger.kind === "child") return undefined;
  return matchesRecoveryRuntime(threadId, turn, record) ? turn : undefined;
}

function matchesRecoveryRuntime(threadId: string, turn: AgentTurn, record: ThreadRecord | undefined): boolean {
  if (!record) return turn.status === "Running";
  if (record.runtimePhase === "running") return getCanonicalRuntimeTurn(threadId, record)?.id === turn.id;
  return !record.turnExecutionId || turn.executionId === record.turnExecutionId;
}

function recoveredNarrative(turn: AgentTurn, items: readonly ParentNarrativeRecoveryItem[]) {
  const tools = items.filter((item) => item.kind === "toolCall");
  const thoughts = items.filter((item) => item.kind === "narrationSegment");
  const hooks = items.filter((item) => item.kind === "hook");
  const streaming = thoughts.filter((item) => item.record.is_final_response === 1)
    .map((item) => item.record.text).join("");
  const terminal = turn.status !== "Pending" && turn.status !== "Running";
  const patch: Partial<ThreadRecord> = {
    toolCalls: tools.map((item) => {
      const tool = recordToToolCall(item.record);
      return terminal ? { ...tool, isComplete: true } : tool;
    }),
    thoughtSegments: thoughts.filter((item) => item.record.is_final_response !== 1).map(({ record }) => ({
      text: record.text, startedAt: Date.parse(record.started_at),
      ...(record.ended_at ? { endedAt: Date.parse(record.ended_at) } : {}),
      isExplicitNonFinal: record.is_final_response === 0 || record.ended_at !== null,
    })),
    hooks: hooks.map((item) => recordToHookExecution(item.record)),
    streaming: terminal ? "" : streaming, streamingPreview: terminal ? "" : streaming.slice(-200),
    agentStartTime: Date.parse(turn.startedAt ?? turn.createdAt),
  };
  return { patch, terminal, streaming };
}

function recoveredTerminalResponse(threadId: string, turn: AgentTurn, state: AgentModelState, record: ThreadRecord, text: string): Partial<ThreadRecord> {
  const persisted = Object.values(state.items).filter((item) => item.turnId === turn.id && item.payload.projection === "message")
    .map((item) => MessageSchema().safeParse(item.payload.message)).find((parsed) => parsed.success && parsed.data.role === "assistant");
  if (!persisted && text.length === 0) return {};
  const id = persisted?.success ? persisted.data.id : record.currentTurnMessageId || `canonical-recovery:${turn.id}`;
  const previous = record.messages.find((message) => message.id === id);
  const message = persisted?.success ? persisted.data : terminalMessage(threadId, turn, record, text, id, previous);
  const responseKey = `canonical-turn-response:${turn.id}`;
  const replaced = new Set([id, ...(record.pendingTurnPersistMessageIds.includes(record.currentTurnMessageId) ? [record.currentTurnMessageId] : [])]);
  return {
    messages: [...record.messages.filter((candidate) => !replaced.has(candidate.id)), message],
    currentTurnMessageId: id,
    pendingTurnPersistMessageIds: [...new Set([...record.pendingTurnPersistMessageIds.filter((pending) => !replaced.has(pending)), id])],
    assistantResponseKeys: { ...record.assistantResponseKeys, [id]: responseKey },
  };
}

function terminalMessage(threadId: string, turn: AgentTurn, record: ThreadRecord, text: string, id: string, previous: Message | undefined): Message {
  return {
    id, thread_id: threadId, role: "assistant", content: text,
    tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
    timestamp: turn.endedAt ?? turn.updatedAt, sequence: previous?.sequence ?? (record.messages.at(-1)?.sequence ?? 0) + 1,
    attachments: null,
  };
}
