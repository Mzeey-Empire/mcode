import type { AgentEvent, ParentNarrativeRecoveryItem, StoredAttachment } from "@mcode/contracts";
import { NarrativeTurnState, type NarrativeTurnStateEffect } from "../conversation/narrative/narrative-turn-state.js";
import { AssistantExecutionState, type AssistantMaterializationInput } from "../turns/assistant-execution-state.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";

type ToolUseEvent = Extract<AgentEvent, { type: "toolUse" }>;
type ToolResultEvent = Extract<AgentEvent, { type: "toolResult" }>;
type MessageEvent = Extract<AgentEvent, { type: "message" }>;
type TextDeltaEvent = Extract<AgentEvent, { type: "textDelta" }>;

/** Data to commit for one provider event before releasing its publication. */
export type CodexLiveWriterIntent =
  | { readonly kind: "turn-started" }
  | { readonly kind: "assistant-text-delta"; readonly delta: string; readonly classification: "final" | "unknown" }
  | { readonly kind: "assistant-text-reclassify"; readonly text: string; readonly classification: "narration" }
  | { readonly kind: "assistant-text-promote"; readonly text: string }
  | { readonly kind: "assistant-body"; readonly content: string; readonly model: string | null; readonly attachments: StoredAttachment[]; readonly tokens: number | null }
  | { readonly kind: "generated-attachment"; readonly attachment: StoredAttachment }
  | { readonly kind: "tool-use"; readonly event: ToolUseEvent }
  | { readonly kind: "tool-result"; readonly event: ToolResultEvent }
  | { readonly kind: "hook-started"; readonly hookId: string; readonly late: boolean }
  | { readonly kind: "hook-completed"; readonly hookId: string; readonly late: boolean; readonly exitCode: number; readonly durationMs: number; readonly didBlock: boolean }
  | { readonly kind: "narrative-recovery"; readonly items: ParentNarrativeRecoveryItem[] }
  | { readonly kind: "narrative-effect"; readonly effect: NarrativeTurnStateEffect }
  | { readonly kind: "feature-event"; readonly feature: "plan-text" | "assistant-message" | "task-tool" | "goal-refresh"; readonly event: AgentEvent }
  | { readonly kind: "terminal-projection"; readonly source: "turnComplete" | "ended"; readonly outcome: "completed" | "errored" | "interrupted"; readonly assistant: AssistantMaterializationInput; readonly narrative: ParentNarrativeRecoveryItem[] }
  | { readonly kind: "turn-ended" };

/** A publication is released only after the writer accepts every intent for the event. */
export interface CodexLivePublicationIntent {
  readonly event: AgentEvent;
  readonly after: "writer" | "terminal";
}

/** Unsupported means no reducer state was changed and no publication may be emitted. */
export type CodexLiveReduction =
  | { readonly kind: "reduced"; readonly execution: ExecutionIdentity; readonly writer: CodexLiveWriterIntent[]; readonly publication: CodexLivePublicationIntent }
  | { readonly kind: "unsupported"; readonly eventType: AgentEvent["type"]; readonly reason: string };

/**
 * Reduces one Codex execution's live AgentEvents without database or transport calls.
 * The caller must discard this instance if its writer operation fails, because
 * the next event may only observe state whose preceding intents were committed.
 */
export class CodexLiveEventReducer {
  private readonly narrative: NarrativeTurnState;
  private readonly assistant = new AssistantExecutionState();
  private phase: "awaiting-start" | "active" | "completed" | "ended" = "awaiting-start";
  private unknownText = "";
  private knownFinalText = false;

  constructor(readonly execution: ExecutionIdentity) {
    this.narrative = new NarrativeTurnState(execution);
  }

  reduce(input: AgentEvent): CodexLiveReduction {
    const rejection = this.identityRejection(input) ?? this.phaseRejection(input) ?? this.textRejection(input);
    if (rejection) return this.unsupported(input, rejection);
    let event: AgentEvent;
    try {
      event = structuredClone({ ...input, turnExecutionId: this.execution.executionId });
    } catch {
      return this.unsupported(input, "event is not cloneable");
    }

    const writer = this.apply(event);
    if (!writer) return this.unsupported(input, "event needs a separate feature owner");
    for (const effect of this.narrative.takeEffects()) writer.push({ kind: "narrative-effect", effect });
    return structuredClone({
      kind: "reduced",
      execution: this.execution,
      writer,
      publication: {
        event: this.publicationEvent(event),
        after: this.publicationBarrier(event),
      },
    });
  }

  private identityRejection(event: AgentEvent): string | undefined {
    if (event.threadId !== this.execution.threadId) return "different thread";
    if (event.turnExecutionId && event.turnExecutionId !== this.execution.executionId) return "different execution";
    return undefined;
  }

  private phaseRejection(event: AgentEvent): string | undefined {
    if (this.phase === "ended") return "execution already ended";
    if (this.phase === "awaiting-start" && event.type !== "turnStarted") return "turn has not started";
    if (this.phase !== "awaiting-start" && event.type === "turnStarted") return "turn already started";
    if (this.phase === "completed" && event.type !== "ended" && event.type !== "hookStarted" && event.type !== "hookCompleted") {
      return "event after turn completion requires another owner";
    }
    return undefined;
  }

  private textRejection(event: AgentEvent): string | undefined {
    switch (event.type) {
      case "assistantMessageBoundary":
        return !event.isFinalResponse && this.knownFinalText
          ? "mixed final and unknown assistant text" : undefined;
      case "textDelta": return this.deltaRejection(event);
      case "turnComplete":
      case "ended":
        return this.unknownText ? "assistant text still lacks a boundary" : undefined;
      default: return undefined;
    }
  }

  private deltaRejection(event: TextDeltaEvent): string | undefined {
    if (event.isFinalResponse === false && this.knownFinalText) return "mixed final and nonfinal assistant text";
    if (event.isFinalResponse !== undefined && this.unknownText) return "mixed classified and unknown assistant text";
    return undefined;
  }

  private publicationEvent(event: AgentEvent): AgentEvent {
    return event.type === "ended" && event.outcome === "cancelled"
      ? { ...event, outcome: "interrupted" }
      : event;
  }

  private publicationBarrier(event: AgentEvent): "writer" | "terminal" {
    return this.phase === "completed" || (event.type === "ended" && event.outcome !== undefined)
      ? "terminal" : "writer";
  }

  private apply(event: AgentEvent): CodexLiveWriterIntent[] | undefined {
    return this.applyNarrative(event) ?? this.applyLifecycle(event);
  }

  private applyNarrative(event: AgentEvent): CodexLiveWriterIntent[] | undefined {
    switch (event.type) {
      case "textDelta": return this.textDelta(event);
      case "assistantMessageBoundary": return this.boundary(event);
      case "message": return this.message(event);
      case "generatedAttachment": return this.attachment(event);
      case "toolUse": return this.toolUse(event);
      case "toolResult": return this.toolResult(event);
      case "hookStarted": return this.hookStarted(event);
      case "hookCompleted": return this.hookCompleted(event);
      default: return undefined;
    }
  }

  private applyLifecycle(event: AgentEvent): CodexLiveWriterIntent[] | undefined {
    switch (event.type) {
      case "turnStarted": return this.start(event);
      case "turnComplete": return this.turnComplete(event);
      case "ended": return this.ended(event);
      default: return undefined;
    }
  }

  private start(event: Extract<AgentEvent, { type: "turnStarted" }>): CodexLiveWriterIntent[] {
    this.narrative.beginTurn(event.threadId);
    this.narrative.resetTurnCounters(event.threadId);
    this.phase = "active";
    return [{ kind: "turn-started" }];
  }

  private textDelta(event: TextDeltaEvent): CodexLiveWriterIntent[] {
    const writer: CodexLiveWriterIntent[] = [{ kind: "feature-event", feature: "plan-text", event }];
    if (event.isFinalResponse === false) {
      this.narrative.openOrExtendThought(event.threadId, event.delta);
      writer.push(this.recovery());
    } else {
      this.assistant.appendStreamingText(event.delta);
      if (event.isFinalResponse === undefined) this.unknownText += event.delta;
      else this.knownFinalText = true;
      writer.push({ kind: "assistant-text-delta", delta: event.delta, classification: event.isFinalResponse ? "final" : "unknown" });
    }
    return writer;
  }

  private boundary(event: Extract<AgentEvent, { type: "assistantMessageBoundary" }>): CodexLiveWriterIntent[] {
    const writer: CodexLiveWriterIntent[] = [];
    if (event.isFinalResponse) {
      const text = this.narrative.takeOpenThought(event.threadId);
      if (text) {
        this.assistant.appendStreamingText(text);
        writer.push({ kind: "assistant-text-promote", text });
      }
      this.unknownText = "";
    } else {
      if (this.unknownText) {
        const staged = this.narrative.stageNarrationSegment(event.threadId, this.unknownText);
        if (staged) this.narrative.applyStagedNarrationSegment(event.threadId, staged);
        writer.push({ kind: "assistant-text-reclassify", text: this.unknownText, classification: "narration" });
        this.assistant.resetStreamingText();
        this.unknownText = "";
      }
      this.narrative.closeOpenThought(event.threadId);
    }
    this.knownFinalText = false;
    writer.push(this.recovery());
    return writer;
  }

  private message(event: MessageEvent): CodexLiveWriterIntent[] {
    this.assistant.bufferBody(event.content, event.model ?? null, event.attachments ?? []);
    const body = this.assistant.materializationInput(event.model ?? null);
    this.assistant.resetStreamingText();
    this.narrative.clearAgentStackOnMessage(event.threadId);
    this.knownFinalText = false;
    this.unknownText = "";
    return [
      { kind: "assistant-body", content: body.content, model: body.model, attachments: body.attachments, tokens: event.tokens },
      { kind: "feature-event", feature: "assistant-message", event },
    ];
  }

  private attachment(event: Extract<AgentEvent, { type: "generatedAttachment" }>): CodexLiveWriterIntent[] {
    this.assistant.bufferAttachments([event.attachment]);
    return [{ kind: "generated-attachment", attachment: event.attachment }];
  }

  private toolUse(event: ToolUseEvent): CodexLiveWriterIntent[] {
    this.narrative.closeOpenThought(event.threadId);
    const parentToolCallId = this.narrative.bufferToolCall(event.threadId, event);
    const attributed = { ...event, parentToolCallId };
    return [
      { kind: "tool-use", event: attributed },
      { kind: "feature-event", feature: "task-tool", event: attributed },
      this.recovery(),
    ];
  }

  private toolResult(event: ToolResultEvent): CodexLiveWriterIntent[] {
    this.narrative.updateBufferedToolCallOutput(event.threadId, event.toolCallId, event.output, event.isError,
      event.toolInput, {
        exitCode: event.exitCode,
        outputTruncated: event.outputTruncated,
        outputTotalBytes: event.outputTotalBytes,
        outputArtifactPath: event.outputArtifactPath,
      }, event.subagentPresentation);
    return [
      { kind: "tool-result", event },
      { kind: "feature-event", feature: "task-tool", event },
      this.recovery(),
    ];
  }

  private hookStarted(event: Extract<AgentEvent, { type: "hookStarted" }>): CodexLiveWriterIntent[] {
    const late = this.phase === "completed";
    if (!late) this.narrative.closeOpenThought(event.threadId);
    const hookId = this.narrative.openHook(event.threadId, {
      hookName: event.hookName,
      toolName: late ? null : event.toolName ?? null,
      phase: late ? "stop" : event.hookType,
      payload: JSON.stringify({ hookType: late ? "stop" : event.hookType, toolName: late ? null : event.toolName ?? null }),
      sortOrder: this.narrative.nextSortOrder(event.threadId),
    });
    return [{ kind: "hook-started", hookId, late }, this.recovery()];
  }

  private hookCompleted(event: Extract<AgentEvent, { type: "hookCompleted" }>): CodexLiveWriterIntent[] {
    const open = this.narrative.peekOpenHook(event.threadId, event.hookName);
    if (!open) return [];
    this.narrative.pushClosedHook(event.threadId, {
      ...open,
      messageId: "",
      durationMs: event.durationMs,
      didBlock: event.didBlock,
      endedAt: new Date().toISOString(),
    });
    this.narrative.removeOpenHook(event.threadId, event.hookName);
    return [{ kind: "hook-completed", hookId: open.id, late: this.phase === "completed",
      exitCode: event.exitCode, durationMs: event.durationMs, didBlock: event.didBlock }, this.recovery()];
  }

  private turnComplete(event: Extract<AgentEvent, { type: "turnComplete" }>): CodexLiveWriterIntent[] {
    this.phase = "completed";
    return [
      { kind: "terminal-projection", source: "turnComplete", outcome: "completed",
        assistant: this.assistant.materializationInput(null), narrative: this.narrative.recoverySnapshot(event.threadId) },
      { kind: "feature-event", feature: "goal-refresh", event },
    ];
  }

  private ended(event: Extract<AgentEvent, { type: "ended" }>): CodexLiveWriterIntent[] {
    const writer: CodexLiveWriterIntent[] = [];
    if (event.outcome && this.phase !== "completed") {
      writer.push({ kind: "terminal-projection", source: "ended",
        outcome: event.outcome === "cancelled" ? "interrupted" : event.outcome,
        assistant: this.assistant.materializationInput(null), narrative: this.narrative.recoverySnapshot(event.threadId) });
    }
    writer.push({ kind: "turn-ended" });
    this.phase = "ended";
    return writer;
  }

  private recovery(): CodexLiveWriterIntent {
    return { kind: "narrative-recovery", items: this.narrative.recoverySnapshot(this.execution.threadId) };
  }

  private unsupported(event: AgentEvent, reason: string): CodexLiveReduction {
    return { kind: "unsupported", eventType: event.type, reason };
  }
}
