import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  MessageSchema,
  ProviderRuntimeEventSchema,
  type AgentEvent,
  type AgentItem,
  type AgentThread,
  type AgentTurn,
  type CanonicalAgentEvent,
  type Message,
  type ParentNarrativeRecoveryItem,
  type TurnOutcome,
} from "@mcode/contracts";
import type { ExecutionSemanticOperation, ParentLiveEffects } from "../execution/execution-worker-handler.js";
import { sanitizePublicToolInput } from "../tools/input/public-tool-input.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";
import type { CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";
import { prepareParentNarrativeRecoveryEvents, retainCanonicalSubagentTarget } from "./parent-narrative-recovery-events.js";
import { PROVIDER_FRAME_EVENT_TYPES } from "./provider-frame-events.js";

const MAX_ACCEPTED_OPERATION_EVENTS = 8_192;

/**
 * Prepares parent progress without mutating hydrated state or invoking storage or provider effects. Terminal writes retain only
 * changed source narrative; one response binding settles the already accepted history.
 */
export function prepareAcceptedParentEvents(input: {
  readonly operation: ExecutionSemanticOperation;
  readonly thread: AgentThread;
  readonly turn: AgentTurn;
  readonly items: Readonly<Record<string, AgentItem>>;
  readonly publicationIds: readonly string[];
  readonly messageSequence: number;
  readonly acceptedAt: string;
}): { events: CanonicalAgentEventDraft[]; terminalMessage?: Message; storageOperation?: ExecutionSemanticOperation } {
  validateContext(input);
  const prepared = mutationEvents(input);
  prepared.events = prepared.events.map(withoutNativePlanFile);
  const providerStarted = providerStartedEvent(input);
  // Leads the batch so a turn whose first frame is also its terminal frame still records the answer before it ends.
  if (providerStarted) prepared.events.unshift(providerStarted);
  prepared.events.push(...publicationEvents(input));
  if (prepared.events.length === 0) prepared.events.push(checkpointEvent(input));
  assertEventCount(prepared.events.length);
  return prepared;
}

type PreparationInput = Parameters<typeof prepareAcceptedParentEvents>[0];
type PreparedEvents = ReturnType<typeof prepareAcceptedParentEvents>;

function withoutNativePlanFile(draft: CanonicalAgentEventDraft): CanonicalAgentEventDraft {
  if (draft.payload.type !== "item.recorded" || draft.payload.item.payload.projection !== "providerRuntimeEvent") return draft;
  const item = draft.payload.item;
  // Only strips the private ref; validating runtime events belongs to execution ingress, not this filter.
  const parsed = ProviderRuntimeEventSchema().safeParse(item.payload.runtimeEvent);
  if (!parsed.success) return draft;
  const runtime = parsed.data;
  if (!runtime.planCapture?.nativePlanFile) return draft;
  const { nativePlanFile: _privateRef, ...planCapture } = runtime.planCapture;
  // Ownership evidence persists in plan metadata, outside the public canonical stream.
  return { ...draft, payload: { ...draft.payload, item: { ...item,
    payload: { ...item.payload, runtimeEvent: { ...runtime, planCapture } } } } };
}

function mutationEvents(input: PreparationInput): PreparedEvents {
  const mutation = input.operation.mutation;
  switch (mutation.kind) {
    case "append-events":
      assertEventCount(mutation.events.length);
      return { events: [...mutation.events, ...liveEffectEvents(input, mutation.parentLive)] };
    case "live-event": return { events: liveEffectEvents(input, mutation) };
    case "narrative-delta": return { events: recoveryEvents(input, mutation.input) };
    case "finish-live-event": return terminalEvents(input, mutation);
    case "post-terminal-event": return { events: postTerminalEvents(input, mutation) };
    default: return { events: [] };
  }
}

function liveEffectEvents(input: PreparationInput, effects: ParentLiveEffects | undefined): CanonicalAgentEventDraft[] {
  if (!effects) return [];
  const events = effects.narrative ? recoveryEvents(input, effects.narrative) : [];
  if (effects.message) {
    const message = assistantMessage(input, effects.message.messageId, effects.message);
    events.push(messageEvent(input, message));
  }
  events.push(...assistantTextEvents(input, effects));
  return events;
}

function assistantTextEvents(input: PreparationInput, effects: ParentLiveEffects): CanonicalAgentEventDraft[] {
  const closed = input.operation.livePublication?.map((publication) => publication.event)
    .find((event) => event.type === "assistantMessageBoundary" && event.isFinalResponse);
  if (effects.text.kind === "unchanged" && !effects.message && !closed) return [];
  const id = `assistant-response-text:${input.operation.execution.executionId}`;
  const previous = input.items[id];
  const item: AgentItem = {
    id, threadId: input.thread.id, turnId: input.turn.id, kind: "message", providerIdentities: [],
    payload: assistantTextPayload(previous, effects, closed),
    createdAt: previous?.createdAt ?? input.acceptedAt, updatedAt: input.acceptedAt,
  };
  return [{ eventId: `${input.operation.operationId}:assistant-text`, routing: { ...input.operation.execution, itemId: id },
    sourceProviderId: input.thread.providerId, sourceIdentities: [], payload: { type: "item.recorded", item } }];
}

function assistantTextPayload(previous: AgentItem | undefined, effects: ParentLiveEffects, closed: AgentEvent | undefined) {
  const previousText = typeof previous?.payload.content === "string" ? previous.payload.content : "";
  const boundaryContent = closed?.type === "assistantMessageBoundary" ? closed.content : undefined;
  const content = effects.message?.content ?? boundaryContent ?? nextAssistantText(previousText, effects.text);
  return { projection: "assistantText", content, isStreaming: !effects.message && !closed && content.length > 0 };
}

function nextAssistantText(previous: string, text: ParentLiveEffects["text"]): string {
  switch (text.kind) {
    case "unchanged": return previous;
    case "append": return (text.inputs[0]?.sequence === 1 ? "" : previous) + text.inputs.map((input) => input.text).join("");
    case "promote": return previous + text.input.text;
    case "reclassify": return text.retainedText ?? "";
  }
}

function recoveryEvents(
  input: PreparationInput,
  recovery: Parameters<typeof prepareParentNarrativeRecoveryEvents>[0]["recovery"],
): CanonicalAgentEventDraft[] {
  assertEventCount(recovery.items.length + (recovery.discardedItemIds?.length ?? 0));
  if (recovery.executionId !== input.operation.execution.executionId) {
    throw new Error("Accepted narrative recovery belongs to another execution");
  }
  return prepareParentNarrativeRecoveryEvents({ recovery, thread: input.thread, turn: input.turn,
    findItem: (id) => input.items[id] }).map((event) => ({ ...event,
      eventId: `narrative:${fingerprint([input.operation.operationId, event.eventId])}` }));
}

function terminalEvents(
  input: PreparationInput,
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "finish-live-event" }>,
): PreparedEvents {
  const { projection } = mutation;
  const raw = mutation.providerEvent?.events ?? [];
  const hasMessage = hasTerminalSubstance(projection);
  const narrative = changedTerminalNarrative(input, projection.narrative);
  assertEventCount(raw.length + narrative.length + Number(hasMessage) + 2 + input.publicationIds.length);
  const events: CanonicalAgentEventDraft[] = [...raw];
  const messageId = projection.assistant.messageId
    ?? deriveTurnAssistantMessageId(input.thread.id, `execution:${input.operation.execution.executionId}`);
  events.push(...recoveryEvents(input, { executionId: input.operation.execution.executionId, items: narrative }));
  const terminalMessage = hasMessage ? {
    ...assistantMessage(input, messageId, projection.assistant),
    is_internal: false,
    outcome: mutation.outcome, outcomeExecutionId: input.operation.execution.executionId,
    tool_call_count: projection.narrative.filter((item) => item.kind === "toolCall").length,
    files_changed: mutation.input.fileEvidence ? [...mutation.input.fileEvidence.filesChanged] : null,
  } : undefined;
  if (terminalMessage) events.push(messageEvent(input, terminalMessage, mutation.input.providerIdentities));
  events.push({ eventId: `${input.operation.operationId}:response-bound`, routing: input.operation.execution,
    sourceProviderId: mutation.input.providerId, sourceIdentities: mutation.input.providerIdentities,
    payload: { type: "turn.response-bound", messageId, outcome: mutation.outcome, endedAt: projection.endedAt } });
  const payload = terminalPayload(mutation.outcome, mutation.input.error, projection.endedAt);
  events.push({ eventId: `${input.operation.execution.executionId}:${payload.type}`,
    routing: input.operation.execution, sourceProviderId: mutation.input.providerId,
    sourceIdentities: mutation.input.providerIdentities, payload });
  const storageOperation: ExecutionSemanticOperation = { ...input.operation, mutation: { ...mutation,
    projection: { ...projection, narrative, assistant: { ...projection.assistant, messageId } },
    input: { ...mutation.input, projection: { kind: "writer-staged", messageId } },
  } };
  return { events, ...(terminalMessage ? { terminalMessage } : {}), storageOperation };
}

function changedTerminalNarrative(input: PreparationInput,
  narrative: readonly ParentNarrativeRecoveryItem[]): ParentNarrativeRecoveryItem[] {
  return narrative.flatMap((entry) => {
    const existing = input.items[`${entry.kind}:${entry.record.id}`];
    if (!existing || existing.threadId !== input.thread.id || existing.turnId !== input.turn.id) return [entry];
    const canonical = retainCanonicalSubagentTarget(entry, existing.payload);
    if (existing.payload.projection === "narrativeRecovery") {
      return NodeUtil.isDeepStrictEqual(canonical, existing.payload.narrative) ? [] : [canonical];
    }
    return existing.payload.projection === canonical.kind && NodeUtil.isDeepStrictEqual(canonical.record, existing.payload.record) ? [] : [canonical];
  });
}

function hasTerminalSubstance(projection: Extract<ExecutionSemanticOperation["mutation"], { kind: "finish-live-event" }>["projection"]): boolean {
  return Boolean(projection.assistant.content.trim()) || projection.assistant.attachments.length > 0
    || projection.narrative.length > 0;
}

function assistantMessage(
  input: PreparationInput,
  id: string,
  assistant: { readonly content: string; readonly model: string | null; readonly attachments: Readonly<NonNullable<Message["attachments"]>> | null },
): Message {
  const existing = input.items[`message:${id}`];
  const original = existingAssistantMessage(existing);
  assertAcceptedAssistantIdentity(input, original, existing);
  return { id, thread_id: input.thread.id, role: "assistant", content: assistant.content,
    is_internal: true,
    tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
    timestamp: original?.timestamp ?? input.acceptedAt, sequence: original?.sequence ?? input.messageSequence,
    model: assistant.model, attachments: assistantAttachments(assistant) };
}

function existingAssistantMessage(item: AgentItem | undefined): Message | undefined {
  if (item?.payload.projection !== "message") return undefined;
  return MessageSchema().parse(item.payload.message);
}

function assertAcceptedAssistantIdentity(input: PreparationInput, original: Message | undefined, item: AgentItem | undefined): void {
  if (!original) return;
  if (original.thread_id !== input.thread.id || original.role !== "assistant" || item?.turnId !== input.turn.id) {
    throw new Error("Accepted assistant identity belongs to a different message");
  }
}

function assistantAttachments(assistant: { readonly attachments: Readonly<NonNullable<Message["attachments"]>> | null }): Message["attachments"] {
  return assistant.attachments ? [...assistant.attachments] : null;
}

function messageEvent(input: PreparationInput, message: Message,
  identities: Readonly<AgentTurn["providerIdentities"]> = input.turn.providerIdentities): CanonicalAgentEventDraft {
  return itemEvent(input, { id: `message:${message.id}`, threadId: input.thread.id, turnId: input.turn.id,
    kind: "message", providerIdentities: [...identities], payload: { projection: "message", message },
    createdAt: message.timestamp, updatedAt: message.timestamp });
}

function narrativeEvent(input: PreparationInput, entry: ParentNarrativeRecoveryItem,
  identities: Readonly<AgentTurn["providerIdentities"]> = input.turn.providerIdentities): CanonicalAgentEventDraft {
  const parentItemId = entry.kind === "toolCall" && entry.record.parent_tool_call_id
    ? `toolCall:${entry.record.parent_tool_call_id}` : undefined;
  const updatedAt = entry.kind === "toolCall" ? entry.record.completed_at : entry.record.ended_at;
  return itemEvent(input, { id: `${entry.kind}:${entry.record.id}`, threadId: input.thread.id, turnId: input.turn.id,
    ...(parentItemId ? { parentItemId } : {}), kind: narrativeKind(entry), providerIdentities: [...identities],
    payload: { projection: entry.kind, record: entry.record },
    createdAt: entry.record.started_at, updatedAt: updatedAt ?? entry.record.started_at });
}

function narrativeKind(entry: ParentNarrativeRecoveryItem): AgentItem["kind"] {
  switch (entry.kind) {
    case "toolCall": return "tool-call";
    case "narrationSegment": return "reasoning";
    case "hook": return "system";
  }
}

function itemEvent(input: PreparationInput, item: AgentItem): CanonicalAgentEventDraft {
  return { eventId: `${input.operation.operationId}:item:${item.id}:${fingerprint(item.payload)}`,
    routing: { ...input.operation.execution, itemId: item.id }, sourceProviderId: input.thread.providerId,
    sourceIdentities: item.providerIdentities, payload: { type: "item.recorded", item } };
}

function postTerminalEvents(input: PreparationInput,
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "post-terminal-event" }>): CanonicalAgentEventDraft[] {
  const raw = mutation.providerEvent?.events ?? [];
  const hooks = mutation.hooks ?? [];
  assertEventCount(raw.length + hooks.length);
  if (hooks.length === 0) return [...raw];
  const message = terminalAssistant(input);
  return [...raw, ...hooks.map((hook) => {
    if (hook.record.message_id && hook.record.message_id !== message.id) {
      throw new Error("Accepted terminal hook belongs to another assistant message");
    }
    return narrativeEvent(input, { ...hook, record: { ...hook.record, message_id: message.id } });
  })];
}

function terminalAssistant(input: PreparationInput): Message {
  for (const item of Object.values(input.items)) {
    if (item.turnId !== input.turn.id || item.threadId !== input.thread.id || item.payload.projection !== "message") continue;
    const parsed = MessageSchema().safeParse(item.payload.message);
    if (parsed.success && parsed.data.role === "assistant"
      && parsed.data.outcomeExecutionId === input.operation.execution.executionId) return parsed.data;
  }
  throw new Error("Accepted terminal hook requires its terminal assistant message");
}

function publicationEvents(input: PreparationInput): CanonicalAgentEventDraft[] {
  return (input.operation.livePublication ?? []).map((publication, index) => {
    const publicationId = input.publicationIds[index];
    if (!publicationId || !/^[1-9]\d{0,15}$/.test(publicationId)) {
      throw new Error("Accepted publication requires a valid reserved publication ID");
    }
    const event = terminalHookPublication(input, sanitizePublicationEvent(publication.event));
    return { eventId: `${input.operation.operationId}:publication:${index}`,
      routing: input.operation.execution, sourceProviderId: input.thread.providerId, sourceIdentities: [],
      payload: { type: "publication.recorded", publicationId, event } };
  });
}

function terminalHookPublication(input: PreparationInput, event: AgentEvent): AgentEvent {
  const mutation = input.operation.mutation;
  const hook = mutation.kind === "post-terminal-event" ? mutation.hooks?.[0] : undefined;
  if (event.type !== "hookCompleted" || !hook) return event;
  return { ...event, persistedMessageId: terminalAssistant(input).id, persistedHookId: hook.record.id };
}

function sanitizePublicationEvent(event: AgentEvent): AgentEvent {
  if (event.type === "toolUse") return { ...event, toolInput: sanitizePublicToolInput(event.toolInput, event.toolName) };
  if (event.type === "toolResult" && event.toolInput) return { ...event, toolInput: sanitizePublicToolInput(event.toolInput) };
  return event;
}

function providerStartedEvent(input: PreparationInput): CanonicalAgentEventDraft | undefined {
  if (input.turn.providerStartedAt !== null || input.operation.mutation.kind === "post-terminal-event") return undefined;
  const answered = (input.operation.livePublication ?? [])
    .some((publication) => PROVIDER_FRAME_EVENT_TYPES.has(publication.event.type));
  if (!answered) return undefined;
  const executionId = input.operation.execution.executionId;
  return { eventId: `${executionId}:provider-started`, routing: input.operation.execution,
    sourceProviderId: input.thread.providerId, sourceIdentities: [],
    payload: { type: "turn.provider-started", at: input.acceptedAt } };
}

function checkpointEvent(input: PreparationInput): CanonicalAgentEventDraft {
  return { eventId: `${input.operation.operationId}:checkpoint`, routing: input.operation.execution,
    sourceProviderId: input.thread.providerId, sourceIdentities: [],
    payload: { type: "execution.checkpoint", operationKind: input.operation.mutation.kind } };
}

function terminalPayload(outcome: TurnOutcome, error: string | undefined, endedAt: string): CanonicalAgentEvent {
  switch (outcome) {
    case "completed": return { type: "turn.completed", endedAt };
    case "cancelled": return { type: "turn.cancelled", endedAt, reason: error ?? "Turn cancelled" };
    case "interrupted": return { type: "turn.interrupted", endedAt, reason: error ?? "Turn interrupted" };
    case "errored": return { type: "turn.errored", endedAt, error: error ?? "Provider turn failed" };
  }
}

function validateContext(input: PreparationInput): void {
  const { execution } = input.operation;
  if (execution.threadId !== input.thread.id || execution.turnId !== input.turn.id
    || input.turn.threadId !== input.thread.id || input.turn.executionId !== execution.executionId) {
    throw new Error("Accepted parent events require matching hydrated execution state");
  }
  if (input.publicationIds.length !== (input.operation.livePublication?.length ?? 0)) {
    throw new Error("Accepted publications must match their reserved publication IDs");
  }
  assertEventCount(input.publicationIds.length);
  validateMessageOrdering(input);
}

function validateMessageOrdering(input: PreparationInput): void {
  if (!Number.isSafeInteger(input.messageSequence) || input.messageSequence < 1 || !Number.isFinite(Date.parse(input.acceptedAt))) {
    throw new Error("Accepted parent events require a valid timestamp and message sequence");
  }
}

function assertEventCount(count: number): void {
  if (count > MAX_ACCEPTED_OPERATION_EVENTS) throw new Error("Accepted parent operation exceeds its event limit");
}

function fingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
