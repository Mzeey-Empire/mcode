import { MessageSchema, ParentNarrativeRecoveryItemSchema, type AgentModelState, type Message,
  type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import type { ExecutionSemanticOperation, ParentLiveEffects } from "../execution/execution-worker-handler.js";
import type { ExecutionIdentity, ExecutionLease } from "../execution/execution-mailbox-protocol.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";

/** Accepted semantic state needed by controls while its storage suffix is pending. */
export interface AcceptedExecutionState {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  readonly providerId: string;
  readonly assistant: Message;
  readonly nativeCursor: unknown | null;
  readonly phase: string;
}

/** Seed stable message identity from the durable prompt before the provider starts. */
export function seedAcceptedExecution(operation: ExecutionSemanticOperation, state: AgentModelState): AcceptedExecutionState {
  if (operation.mutation.kind !== "begin") throw new Error("Accepted execution seed requires parent admission");
  const input = operation.mutation.input;
  const preceding = Object.values(state.items).flatMap((item) => {
    const parsed = item.payload.projection === "message" ? MessageSchema().safeParse(item.payload.message) : undefined;
    return parsed?.success && parsed.data.id === input.userMessage.messageId ? [parsed.data] : [];
  })[0];
  if (!preceding) throw new Error("Accepted execution seed has no admitted user message");
  const assistant: Message = { id: deriveTurnAssistantMessageId(operation.execution.threadId, preceding.id),
    thread_id: operation.execution.threadId, role: "assistant", content: "", tool_calls: null, files_changed: null,
    cost_usd: null, tokens_used: null, timestamp: new Date().toISOString(), sequence: preceding.sequence + 1,
    model: null, attachments: null };
  return { execution: operation.execution, lease: operation.lease, ordinal: operation.ordinal,
    providerId: operation.mutation.providerId, assistant, nativeCursor: null, phase: "running" };
}

/** Derive a candidate from immutable accepted intents, installing it only after admission. */
export function advanceAcceptedExecution(head: AcceptedExecutionState, operation: ExecutionSemanticOperation,
  terminalMessage?: Message): AcceptedExecutionState {
  const mutation = operation.mutation;
  const effects = mutation.kind === "live-event" ? mutation : mutation.kind === "append-events" ? mutation.parentLive : undefined;
  const assistant = terminalMessage ?? advanceAssistant(head.assistant, effects);
  const cursor = "nativeCursor" in mutation && mutation.nativeCursor !== null ? mutation.nativeCursor : head.nativeCursor;
  return { ...head, ordinal: operation.ordinal, assistant, nativeCursor: cursor, phase: phaseAfter(head.phase, mutation) };
}

/** Restore complete accepted narrative records for worker-loss terminal presentation. */
export function acceptedNarrative(state: AgentModelState, execution: ExecutionIdentity): ParentNarrativeRecoveryItem[] {
  return Object.values(state.items).flatMap((item) => {
    if (item.turnId !== execution.turnId || item.threadId !== execution.threadId) return [];
    const parsed = ParentNarrativeRecoveryItemSchema().safeParse(item.payload.narrative);
    return parsed.success ? [parsed.data] : [];
  });
}

function advanceAssistant(assistant: Message, effects: ParentLiveEffects | undefined): Message {
  if (!effects) return assistant;
  if (effects.message) return { ...assistant, id: effects.message.messageId, content: effects.message.content,
    model: effects.message.model, attachments: effects.message.attachments ? [...effects.message.attachments] : null };
  const text = effects.text;
  switch (text.kind) {
    case "append": return { ...assistant, content: assistant.content + text.inputs.map((input) => input.text).join("") };
    case "promote": return { ...assistant, content: text.input.text };
    case "reclassify": {
      const retained = text.retainedText ?? "";
      if (assistant.content !== retained + text.expectedText) throw new Error("Accepted text classification does not match its body");
      return { ...assistant, content: retained };
    }
    case "unchanged": return assistant;
  }
}

function phaseAfter(previous: string, mutation: ExecutionSemanticOperation["mutation"]): string {
  switch (mutation.kind) {
    case "finish-live-event": return "finalized";
    case "stop-requested": return "stopping";
    case "checkpoint": return mutation.phase;
    default: return previous;
  }
}
