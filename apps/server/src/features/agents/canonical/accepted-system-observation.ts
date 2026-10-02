import {
  AgentEventIdSchema,
  AgentEventRoutingSchema,
  AgentEventSchema,
  CanonicalTimestampSchema,
  MessageSchema,
  ProviderIdSchema,
  AgentThreadIdSchema,
  type AgentEvent,
  type Message,
} from "@mcode/contracts";
import { v5 as uuidv5 } from "uuid";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";

/** Data-only system observation retained at acceptance before its storage projection. */
export interface AcceptedSystemObservation {
  readonly event: AgentEvent;
  readonly message?: Message;
  readonly threadPatch?: {
    readonly contextTokensUsed?: number;
    readonly contextWindow?: number;
    readonly compactSummary?: string;
  };
  readonly noticeSessionId?: string;
  readonly compacting?: boolean;
}

/**
 * Prepares existing provider notice and context effects for one exact execution.
 * The owner supplies accepted compaction state and handles notice deduplication/session expiry.
 * Session startup without a session ID clears that selection; SDK cursors remain writer intents.
 */
export function prepareAcceptedSystemObservation(input: {
  readonly operationId: string;
  readonly execution: ExecutionIdentity;
  readonly providerId: string;
  readonly event: AgentEvent;
  readonly messageSequence: number;
  readonly acceptedAt: string;
  readonly compacting: boolean;
}): AcceptedSystemObservation {
  validateInput(input);
  const event = AgentEventSchema().parse(input.event);
  if (event.threadId !== input.execution.threadId || event.turnExecutionId !== input.execution.executionId) {
    throw new Error("Accepted system observation lacks exact execution ownership");
  }
  switch (event.type) {
    case "system": return systemObservation({ ...input, threadId: input.execution.threadId }, event);
    case "compacting": return event.active
      ? { event, compacting: true }
      : { event, compacting: false, message: systemMessage({ ...input, threadId: input.execution.threadId }, "Context compacted") };
    case "compactSummary": return { event, compacting: false, threadPatch: { compactSummary: event.summary } };
    case "contextEstimate":
    case "turnComplete": return contextObservation(input, event);
    default: return { event };
  }
}

type PreparationInput = Parameters<typeof prepareAcceptedSystemObservation>[0];
type SystemEvent = Extract<AgentEvent, { type: "system" }>;
type SystemMessageInput = Pick<PreparationInput, "operationId" | "messageSequence" | "acceptedAt"> & { readonly threadId: string };

/** Prepare a session diagnostic without inventing provider turn ownership. */
export function prepareAcceptedThreadSystemObservation(input: SystemMessageInput & {
  readonly providerId: string;
  readonly event: SystemEvent;
}): AcceptedSystemObservation {
  AgentThreadIdSchema.parse(input.threadId);
  AgentEventIdSchema.parse(input.operationId);
  ProviderIdSchema.parse(input.providerId);
  CanonicalTimestampSchema.parse(input.acceptedAt);
  if (input.operationId.length > 240 || input.operationId.trim() !== input.operationId
    || !Number.isSafeInteger(input.messageSequence) || input.messageSequence < 0) {
    throw new Error("Invalid accepted thread system observation identity or sequence");
  }
  const event = AgentEventSchema().parse(input.event);
  if (event.type !== "system" || event.threadId !== input.threadId) {
    throw new Error("Thread system observation must retain its source thread ownership");
  }
  return systemObservation(input, event);
}

function validateInput(input: PreparationInput): void {
  AgentEventIdSchema.parse(input.operationId);
  if (input.operationId.length > 240 || input.operationId.trim() !== input.operationId) {
    throw new Error("Accepted system operation identity must be immutable and at most 240 characters");
  }
  AgentEventRoutingSchema.parse(input.execution);
  ProviderIdSchema.parse(input.providerId);
  CanonicalTimestampSchema.parse(input.acceptedAt);
  if (!Number.isSafeInteger(input.messageSequence) || input.messageSequence < 0) {
    throw new Error("Accepted system message sequence must be a nonnegative safe integer");
  }
}

function systemObservation(input: SystemMessageInput, event: SystemEvent): AcceptedSystemObservation {
  if (event.subtype === "provider.session.started") return { event, noticeSessionId: event.systemNotice?.sessionId };
  if (!event.subtype.startsWith("provider.notice.") || !event.message) return { event };
  const message = systemMessage(input, event.message, event.systemNotice);
  if (event.messageId !== undefined && event.messageId !== message.id) {
    throw new Error("Accepted system notice has a conflicting message identity");
  }
  return { event: { ...event, messageId: message.id }, message };
}

function systemMessage(input: SystemMessageInput, content: string, systemNotice?: SystemEvent["systemNotice"]): Message {
  return MessageSchema().parse({
    id: uuidv5(`mcode:accepted-system-observation:${input.operationId}`, uuidv5.URL),
    thread_id: input.threadId,
    role: "system",
    content,
    timestamp: input.acceptedAt,
    sequence: input.messageSequence,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    attachments: null,
    model: null,
    is_internal: false,
    ...(systemNotice ? { systemNotice } : {}),
  });
}

function contextUsage(event: Extract<AgentEvent, { type: "contextEstimate" | "turnComplete" }>): AcceptedSystemObservation {
  return event.tokensIn > 0 ? {
    event,
    threadPatch: {
      contextTokensUsed: event.tokensIn,
      ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
    },
  } : { event };
}

function contextObservation(
  input: PreparationInput,
  event: Extract<AgentEvent, { type: "contextEstimate" | "turnComplete" }>,
): AcceptedSystemObservation {
  if (event.type === "contextEstimate") {
    return event.totalProcessedTokens === undefined || input.compacting ? { event } : contextUsage(event);
  }
  if (event.providerId !== undefined && event.providerId !== input.providerId) {
    throw new Error("Accepted context usage belongs to another provider");
  }
  if (input.compacting) throw new Error("Turn completion during active compaction needs its lifecycle owner");
  return contextUsage(event);
}
