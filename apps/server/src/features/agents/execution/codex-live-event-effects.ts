import type { DataOnlyParentTerminalProjectionInput } from "../canonical/canonical-parent-turn-write.js";
import type { CodexSystemWriterIntent } from "../canonical/canonical-codex-system-error-projection.js";
import { taskToolWriteIntents, type TaskToolCall } from "../tasks/task-tool-intent-reducer.js";
import { NarrativeRecoveryDelta } from "../turns/narrative-recovery-delta.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";
import type { ParentAssistantTextCheckpointInput } from "../turns/parent-assistant-text-checkpoint-service.js";
import type { CodexLiveReduction, CodexLiveWriterIntent } from "./codex-live-event-reducer.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import type { ExecutionLivePublicationIntent, ParentLiveEffects } from "./execution-worker-handler.js";

type ReducedEvent = Extract<CodexLiveReduction, { kind: "reduced" }>;
type TerminalIntent = Extract<CodexLiveWriterIntent, { kind: "terminal-projection" }>;

/** Effects that still require an execution runtime or a canonical projection owner. */
export type CodexLiveRuntimeIntent = Extract<CodexLiveWriterIntent, { kind:
  "turn-started" | "generated-attachment" | "tool-use" | "tool-result" | "hook-started"
  | "hook-completed" | "narrative-effect" | "context-usage" | "compaction-started"
  | "compaction-divider" | "compaction-summary" | "turn-error" | "turn-ended"
}> | { readonly kind: "feature-event"; readonly feature: "goal-refresh"; readonly event: ReducedEvent["publication"]["event"] };

/** Cloneable parent writes and the remaining work required before publication. */
export interface PreparedCodexLiveEvent {
  readonly effects: ParentLiveEffects;
  readonly publication: ExecutionLivePublicationIntent;
  readonly runtime: readonly CodexLiveRuntimeIntent[];
  readonly terminal?: DataOnlyParentTerminalProjectionInput;
}

/**
 * Maps one execution's reduced events to writer data. Advance only in mailbox order;
 * discard this mapper and its reducer if a prepared operation fails to commit.
 */
export class CodexLiveEventEffects {
  private sequence = 0;
  private readonly narrative = new NarrativeRecoveryDelta();
  private readonly calls = new Map<string, TaskToolCall>();
  private assignedMessageId: string | undefined;

  constructor(private readonly execution: ExecutionIdentity, private readonly precedingMessageId: string) {}

  /** Prepare every parent write while retaining intents owned by other execution collaborators. */
  prepare(reduction: ReducedEvent, endedAt = new Date().toISOString()): PreparedCodexLiveEvent {
    this.requireExecution(reduction);
    let effects: ParentLiveEffects = { text: { kind: "unchanged" } };
    const runtime: CodexLiveRuntimeIntent[] = [];
    let terminal: DataOnlyParentTerminalProjectionInput | undefined;
    for (const intent of reduction.writer) {
      if (intent.kind === "terminal-projection") terminal = this.terminalProjection(intent, endedAt);
      else effects = this.applyIntent(intent, effects, runtime);
    }
    const event = reduction.publication.event;
    const publication = event.type === "message" && effects.message
      ? { ...reduction.publication, event: { ...event, messageId: effects.message.messageId } }
      : reduction.publication;
    return structuredClone({ effects, publication, runtime, ...(terminal ? { terminal } : {}) });
  }

  private requireExecution(reduction: ReducedEvent): void {
    const actual = reduction.execution;
    const event = reduction.publication.event;
    if (actual.threadId !== this.execution.threadId || actual.turnId !== this.execution.turnId
      || actual.executionId !== this.execution.executionId || event.threadId !== actual.threadId
      || event.turnExecutionId !== actual.executionId) throw new Error("Codex effects belong to another execution");
  }

  private applyIntent(
    intent: Exclude<CodexLiveWriterIntent, TerminalIntent>,
    effects: ParentLiveEffects,
    runtime: CodexLiveRuntimeIntent[],
  ): ParentLiveEffects {
    switch (intent.kind) {
      case "assistant-text-delta":
        return intent.delta ? { ...effects, text: { kind: "append", inputs: [this.checkpoint(intent.delta)] } } : effects;
      case "assistant-text-promote":
        return { ...effects, text: { kind: "promote", input: this.checkpoint(intent.text) } };
      case "assistant-text-reclassify":
        this.sequence = 0;
        return { ...effects, text: { kind: "reclassify", expectedText: intent.text } };
      default: return this.applyNonTextIntent(intent, effects, runtime);
    }
  }

  private applyNonTextIntent(
    intent: Exclude<CodexLiveWriterIntent, TerminalIntent | { kind: "assistant-text-delta" | "assistant-text-promote" | "assistant-text-reclassify" }>,
    effects: ParentLiveEffects,
    runtime: CodexLiveRuntimeIntent[],
  ): ParentLiveEffects {
    switch (intent.kind) {
      case "assistant-body": return this.messageEffects(intent, effects);
      case "narrative-recovery": return this.narrativeEffects(intent, effects);
      case "feature-event": return this.featureEffects(intent, effects, runtime);
      case "plan-questions": return { ...effects, planQuestions: intent.questions };
      case "plan-output": return { ...effects, planOutput: intent.output };
      case "notice-session":
      case "system-notice":
      case "session-cursor": return this.systemEffects(intent, effects);
      default: return this.runtimeEffects(intent, effects, runtime);
    }
  }

  private checkpoint(text: string): ParentAssistantTextCheckpointInput {
    return { ...this.execution, sequence: ++this.sequence, text };
  }

  private messageEffects(intent: Extract<CodexLiveWriterIntent, { kind: "assistant-body" }>, effects: ParentLiveEffects): ParentLiveEffects {
    this.assignedMessageId ??= deriveTurnAssistantMessageId(this.execution.threadId, this.precedingMessageId);
    return { ...effects, message: { precedingMessageId: this.precedingMessageId, messageId: this.assignedMessageId,
      content: intent.content, model: intent.model, attachments: intent.attachments } };
  }

  private narrativeEffects(intent: Extract<CodexLiveWriterIntent, { kind: "narrative-recovery" }>, effects: ParentLiveEffects): ParentLiveEffects {
    const delta = this.narrative.prepare(intent.items);
    if (!delta) return effects;
    delta.acknowledge();
    return { ...effects, narrative: { executionId: this.execution.executionId,
      items: delta.items, discardedItemIds: delta.discardedItemIds } };
  }

  private featureEffects(
    intent: Extract<CodexLiveWriterIntent, { kind: "feature-event" }>,
    effects: ParentLiveEffects,
    runtime: CodexLiveRuntimeIntent[],
  ): ParentLiveEffects {
    if (intent.feature === "goal-refresh") runtime.push({ ...intent, feature: "goal-refresh" });
    // The reducer emits parsed plans and assistant bodies as their own intents.
    if (intent.feature !== "task-tool") return effects;
    const event = intent.event;
    const bufferedCalls = [...this.calls.values()];
    const taskIntents = event.type === "toolUse"
      ? taskToolWriteIntents({ kind: "tool-use", ...event, bufferedCalls })
      : event.type === "toolResult"
        ? taskToolWriteIntents({ kind: "tool-result", ...event, bufferedCalls }) : [];
    return taskIntents.length ? { ...effects, taskIntents } : effects;
  }

  private systemEffects(intent: CodexSystemWriterIntent, effects: ParentLiveEffects): ParentLiveEffects {
    return { ...effects, systemIntents: [...effects.systemIntents ?? [], intent] };
  }

  private runtimeEffects(intent: CodexLiveRuntimeIntent, effects: ParentLiveEffects, runtime: CodexLiveRuntimeIntent[]): ParentLiveEffects {
    if (intent.kind === "tool-use") {
      const event = intent.event;
      this.calls.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName,
        parentToolCallId: event.parentToolCallId, _rawToolInput: event.toolInput });
    }
    runtime.push(intent);
    return effects;
  }

  private terminalProjection(intent: TerminalIntent, endedAt: string): DataOnlyParentTerminalProjectionInput {
    return { threadId: this.execution.threadId, executionId: this.execution.executionId,
      outcome: intent.outcome, endedAt,
      assistant: { content: intent.assistant.content, model: intent.assistant.model,
        attachments: intent.assistant.attachments, ...(this.assignedMessageId ? { messageId: this.assignedMessageId } : {}) },
      narrative: intent.narrative };
  }
}
