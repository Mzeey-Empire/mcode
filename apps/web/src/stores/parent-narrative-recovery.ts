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
    ...(items.length > 0 ? { ...narrative.patch, ...recoveredStartTime(turn, record) } : emptyOwnedNarrativePatch(turn, state, record)),
    ...recoveredAssistantText(turn, state),
    ...(record ? recoveredResponse(threadId, turn, state, record, narrative.streaming, narrative.terminal) : {}),
  };
}

function recoveredAssistantText(turn: AgentTurn, state: AgentModelState): Partial<ThreadRecord> {
  const item = state.items[`assistant-response-text:${turn.executionId}`];
  if (!item || item.turnId !== turn.id || item.payload.projection !== "assistantText") return {};
  const content = typeof item.payload.content === "string" ? item.payload.content : "";
  const active = turn.status === "Running";
  const open = responseTextIsOpen(turn, state);
  const hasBody = persistedAssistantMessage(state, turn) !== undefined;
  const visible = active && (open || !hasBody) ? content : "";
  return { streaming: visible, streamingPreview: visible.slice(-200), responseTextIsStreaming: open };
}

function emptyOwnedNarrativePatch(turn: AgentTurn, state: AgentModelState, record: ThreadRecord | undefined): Partial<ThreadRecord> {
  if (!record || record.turnExecutionId !== turn.executionId) return {};
  const discarded = Object.values(state.items).filter((item) => item.turnId === turn.id
    && item.payload.projection === "narrativeRecoveryDiscarded")
    .flatMap((item) => ParentNarrativeRecoveryItemSchema().parse(item.payload.narrative));
  return {
    ...(discarded.some((item) => item.kind === "narrationSegment") ? { thoughtSegments: [] } : {}),
    ...(discarded.some((item) => item.kind === "toolCall") ? { toolCalls: [] } : {}),
    ...(discarded.some((item) => item.kind === "hook") ? { hooks: [] } : {}),
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
      id: record.id, text: record.text, startedAt: Date.parse(record.started_at),
      ...(record.ended_at ? { endedAt: Date.parse(record.ended_at) } : {}),
      isExplicitNonFinal: record.is_final_response === 0 || record.ended_at !== null,
    })),
    hooks: hooks.map((item) => recordToHookExecution(item.record)),
    streaming: terminal ? "" : streaming, streamingPreview: terminal ? "" : streaming.slice(-200),
    responseTextIsStreaming: !terminal && thoughts.some((item) => item.record.is_final_response === 1
      && item.record.ended_at === null && item.record.text.length > 0),
  };
  return { patch, terminal, streaming };
}

/**
 * A running record is already this turn (see `matchesRecoveryRuntime`), usually clocked from the local send.
 * The server turn is created seconds later, so only an earlier start may win; a later one would run the clock backwards.
 */
function recoveredStartTime(turn: AgentTurn, record: ThreadRecord | undefined): Partial<ThreadRecord> {
  const serverStart = Date.parse(turn.startedAt ?? turn.createdAt);
  const localStart = record?.runtimePhase === "running" ? record.agentStartTime : undefined;
  return { agentStartTime: localStart === undefined ? serverStart : Math.min(localStart, serverStart) };
}

function recoveredResponse(threadId: string, turn: AgentTurn, state: AgentModelState, record: ThreadRecord, text: string, terminal: boolean): Partial<ThreadRecord> {
  const persisted = persistedAssistantMessage(state, turn);
  if (!persisted && (!terminal || text.length === 0)) return {};
  const id = persisted?.id ?? (record.currentTurnMessageId || `canonical-recovery:${turn.id}`);
  const previous = record.messages.find((message) => message.id === id);
  const message = persisted ?? terminalMessage(threadId, turn, record, text, id, previous);
  const responseKey = `canonical-turn-response:${turn.id}`;
  const replaced = new Set([id, ...(record.pendingTurnPersistMessageIds.includes(record.currentTurnMessageId) ? [record.currentTurnMessageId] : [])]);
  return {
    messages: [...record.messages.filter((candidate) => !replaced.has(candidate.id)), message],
    ...(responseTextIsOpen(turn, state)
      ? {} : { responseTextIsStreaming: false }),
    currentTurnMessageId: id,
    pendingTurnPersistMessageIds: [...new Set([...record.pendingTurnPersistMessageIds.filter((pending) => !replaced.has(pending)), id])],
    assistantResponseKeys: { ...record.assistantResponseKeys, [id]: responseKey },
  };
}

function responseTextIsOpen(turn: AgentTurn, state: AgentModelState): boolean {
  const item = state.items[`assistant-response-text:${turn.executionId}`];
  return turn.status === "Running" && item?.turnId === turn.id
    && item.payload.projection === "assistantText" && item.payload.isStreaming === true;
}

function persistedAssistantMessage(state: AgentModelState, turn: AgentTurn): Message | undefined {
  for (const item of Object.values(state.items)) {
    if (item.turnId !== turn.id || item.payload.projection !== "message") continue;
    const parsed = MessageSchema().safeParse(item.payload.message);
    if (parsed.success && parsed.data.role === "assistant") return parsed.data;
  }
  return undefined;
}

function terminalMessage(threadId: string, turn: AgentTurn, record: ThreadRecord, text: string, id: string, previous: Message | undefined): Message {
  return {
    id, thread_id: threadId, role: "assistant", content: text,
    tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
    timestamp: turn.endedAt ?? turn.updatedAt, sequence: previous?.sequence ?? (record.messages.at(-1)?.sequence ?? 0) + 1,
    attachments: null,
  };
}
