import { MessageSchema, ParentNarrativeRecoveryItemSchema, type AgentItem, type AgentModelState, type AgentTurn, type Message, type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { recordToApprovalReceipt, recordToHookExecution, recordToToolCall } from "@/features/conversation/narrative/build-persisted-narrative";
import { narrationSegments } from "@/features/conversation/narrative/narrative-thought-classification";
import { backgroundHeldToolIds } from "@/features/conversation/narrative/background-held-tools";
import type { ThreadRecord } from "./thread-record";
import { appendThoughtSegment } from "./thread-store/narrative-projection";
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
  const owned = ownedNarrativePatch(turn, state, record, items, narrative.patch);
  const text = recoveredAssistantText(turn, state);
  const response = record ? recoveredResponse(threadId, turn, state, record, narrative.streaming, narrative.terminal) : {};
  return {
    ...owned,
    ...text,
    ...(record && !serverOwnsThoughtTape(items, owned) ? syncedThoughtTape(record, text.streaming) : {}),
    ...response,
    ...(record && narrative.terminal ? finishedNarrativeCache(record, response.currentTurnMessageId ?? record.currentTurnMessageId, items) : {}),
  };
}

/**
 * User messages the running parent turn took after its prompt (steers). The live timeline renders
 * `record.messages`, which only the send path and the assistant response feed, so without this a
 * steered message would show up only after a reload refetched the transcript.
 */
export function steeredUserMessages(threadId: string, state: AgentModelState, record: ThreadRecord): Message[] {
  // An unloaded transcript is fetched whole later; a lone steer would render without its history.
  if (record.messages.length === 0) return [];
  const turn = recoverableTurn(threadId, state, record);
  if (!turn) return [];
  const shown = new Set(record.messages.map((message) => message.id));
  return Object.values(state.items).flatMap((item) => {
    if (item.turnId !== turn.id || item.payload.projection !== "message") return [];
    const parsed = MessageSchema().safeParse(item.payload.message);
    return parsed.success && parsed.data.role === "user" && !shown.has(parsed.data.id) ? [parsed.data] : [];
  }).sort((left, right) => left.sequence - right.sequence);
}

/**
 * The next turn clears the ephemeral narrative, and only `narrativeByMessage` keeps a finished turn's fold.
 * Without this copy the fold and its decision receipts vanish until a reload refetches them.
 */
function finishedNarrativeCache(record: ThreadRecord, messageId: string, items: readonly ParentNarrativeRecoveryItem[]): Partial<ThreadRecord> {
  if (!messageId || items.length === 0) return {};
  const previous = record.narrativeByMessage[messageId] ?? emptyBucket();
  const recovered = anchoredNarrative(items, messageId);
  return {
    narrativeByMessage: {
      ...record.narrativeByMessage,
      [messageId]: {
        tools: mergeById(previous.tools, recovered.tools),
        thoughts: mergeById(previous.thoughts, recovered.thoughts),
        hooks: mergeById(previous.hooks, recovered.hooks),
        approvals: mergeById(previous.approvals, recovered.approvals),
      },
    },
  };
}

type NarrativeBucket = NonNullable<ThreadRecord["narrativeByMessage"][string]>;

function emptyBucket(): NarrativeBucket {
  return { tools: [], thoughts: [], hooks: [], approvals: [] };
}

/** Live records can carry a provisional message id, so each is re-keyed to the message that owns the bucket. */
function anchoredNarrative(items: readonly ParentNarrativeRecoveryItem[], messageId: string): NarrativeBucket {
  const bucket = emptyBucket();
  for (const item of items) {
    if (item.kind === "toolCall") bucket.tools.push({ ...item.record, message_id: messageId });
    if (item.kind === "narrationSegment") bucket.thoughts.push({ ...item.record, message_id: messageId });
    if (item.kind === "hook") bucket.hooks.push({ ...item.record, message_id: messageId });
    if (item.kind === "approval") bucket.approvals.push({ ...item.record, message_id: messageId });
  }
  return bucket;
}

function mergeById<T extends { id: string; sort_order: number }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id));
}

/** Narration segments, or a discarded-narration marker, mean the server's thought list replaces the local tape. */
function serverOwnsThoughtTape(items: readonly ParentNarrativeRecoveryItem[], owned: Partial<ThreadRecord>): boolean {
  return items.length > 0 ? items.some((item) => item.kind === "narrationSegment") : owned.thoughtSegments !== undefined;
}

/**
 * Undecided text chunks land in both `streaming` and the local thought tape, and the timeline treats
 * `streaming` past the tape as the answer. Without narration segments the server can restore `streaming`
 * but has no record of that tape, so the local tape is kept and extended with the text missed while
 * disconnected. Otherwise the earlier text renders as a thought and the answer restarts at the next chunk.
 */
function syncedThoughtTape(record: ThreadRecord, streaming: string | undefined): Partial<ThreadRecord> {
  const segments = record.thoughtSegments;
  const last = segments.at(-1);
  if (streaming === undefined || !last || last.id?.startsWith("assistant-text:")) return {};
  const tape = narrationSegments(segments).filter((segment) => !segment.id?.startsWith("assistant-text:"))
    .map((segment) => segment.text).join("");
  if (record.streaming !== tape || !streaming.startsWith(tape)) return {};
  return { thoughtSegments: appendThoughtSegment(segments, streaming.slice(tape.length), false) };
}

function ownedNarrativePatch(turn: AgentTurn, state: AgentModelState, record: ThreadRecord | undefined, items: readonly ParentNarrativeRecoveryItem[], patch: Partial<ThreadRecord>): Partial<ThreadRecord> {
  return items.length > 0 ? { ...patch, ...recoveredStartTime(turn, record) } : emptyOwnedNarrativePatch(turn, state, record);
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
    ...(discarded.some((item) => item.kind === "approval") ? { approvals: [] } : {}),
  };
}

function parentNarrativeRecord(item: AgentItem): ParentNarrativeRecoveryItem[] {
  const projection = item.payload.projection;
  if (projection === "narrativeRecovery") return [ParentNarrativeRecoveryItemSchema().parse(item.payload.narrative)];
  if (projection === "toolCall" || projection === "narrationSegment" || projection === "hook" || projection === "approval") {
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
  const approvals = items.filter((item) => item.kind === "approval");
  const streaming = thoughts.filter((item) => item.record.is_final_response === 1)
    .map((item) => item.record.text).join("");
  const terminal = turn.status !== "Pending" && turn.status !== "Running";
  // A background call and the steps under it outlive their terminal turn until the call's own late result settles them.
  const held = backgroundHeldToolIds(tools.map(({ record }) => ({
    id: record.id, parentId: record.parent_tool_call_id, background: record.background === true,
  })));
  const patch: Partial<ThreadRecord> = {
    toolCalls: tools.map((item) => {
      const tool = recordToToolCall(item.record);
      return terminal && !held.has(tool.id) ? { ...tool, isComplete: true } : tool;
    }),
    thoughtSegments: thoughts.filter((item) => item.record.is_final_response !== 1).map(({ record }) => ({
      id: record.id, text: record.text, startedAt: Date.parse(record.started_at),
      ...(record.ended_at ? { endedAt: Date.parse(record.ended_at) } : {}),
      isExplicitNonFinal: record.is_final_response === 0 || record.ended_at !== null,
      ...(record.kind === "reasoning" ? { kind: "reasoning" as const } : {}),
    })),
    hooks: hooks.map((item) => recordToHookExecution(item.record)),
    approvals: approvals.map((item) => recordToApprovalReceipt(item.record)),
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
