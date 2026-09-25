import type { AgentEvent, ParentNarrativeRecoveryItem, PlanQuestion, StoredAttachment, TurnOutcome } from "@mcode/contracts";
import { NarrativeTurnState, type NarrativeTurnStateEffect } from "../conversation/narrative/narrative-turn-state.js";
import { AssistantExecutionState, type AssistantMaterializationInput } from "../turns/assistant-execution-state.js";
import { PlanExecutionState, type PlanPersistenceReady } from "../planning/plan-execution-state.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";

type ToolUseEvent = Extract<AgentEvent, { type: "toolUse" }>;
type ToolResultEvent = Extract<AgentEvent, { type: "toolResult" }>;
type MessageEvent = Extract<AgentEvent, { type: "message" }>;
type TextDeltaEvent = Extract<AgentEvent, { type: "textDelta" }>;
type ContextEvent = Extract<AgentEvent, { type: "contextEstimate" | "turnComplete" }>;
type SystemEvent = Extract<AgentEvent, { type: "system" }>;
const MAX_PLAN_TEXT_BYTES = 256 * 1024;

/** Which plan parser, if any, was armed when this execution began. */
export type CodexPlanFeature = "none" | "questions" | "output";

/** A runtime termination carries its actual failure or cancellation outcome. */
export type SyntheticTerminalInput =
  | { readonly outcome: "errored"; readonly error: string }
  | { readonly outcome: "cancelled" | "interrupted" };

const BEFORE_START_EVENTS = new Set<AgentEvent["type"]>([
  "system", "quotaUpdate", "goalUpdated", "goalCleared", "mcpServerStartupStatus",
]);
const AFTER_COMPLETION_EVENTS = new Set<AgentEvent["type"]>([
  "ended", "hookStarted", "hookProgress", "hookCompleted", ...BEFORE_START_EVENTS,
]);
const TRANSIENT_STATUS_EVENTS = new Set<AgentEvent["type"]>([
  "apiRetry", "rateLimited", "quotaUpdate", "providerUnavailable", "modelFallback",
  "toolInputDelta", "toolProgress", "hookProgress", "goalUpdated", "goalCleared",
  "mcpServerStartupStatus",
]);

// A new contract variant must receive an owner decision before the reducer accepts it.
const UNSUPPORTED_FEATURE_REASON = {
  turnStarted: null,
  message: null,
  generatedAttachment: null,
  toolUse: null,
  toolResult: null,
  turnComplete: null,
  error: null,
  ended: null,
  system: null,
  compacting: null,
  compactSummary: null,
  modelFallback: null,
  textDelta: null,
  toolInputDelta: null,
  toolProgress: null,
  contextEstimate: null,
  quotaUpdate: null,
  providerUnavailable: null,
  rateLimited: null,
  apiRetry: null,
  hookStarted: null,
  hookProgress: null,
  hookCompleted: null,
  assistantMessageBoundary: null,
  goalUpdated: null,
  goalCleared: null,
  mcpServerStartupStatus: null,
} satisfies Record<AgentEvent["type"], string | null>;

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
  | { readonly kind: "plan-questions"; readonly questions: readonly PlanQuestion[] }
  | { readonly kind: "plan-output"; readonly output: PlanPersistenceReady }
  | { readonly kind: "context-usage"; readonly tokensIn: number; readonly contextWindow?: number }
  | { readonly kind: "compaction-started" }
  | { readonly kind: "compaction-divider" }
  | { readonly kind: "compaction-summary"; readonly summary: string }
  | { readonly kind: "notice-session"; readonly event: SystemEvent }
  | { readonly kind: "system-notice"; readonly event: SystemEvent }
  | { readonly kind: "session-cursor"; readonly event: SystemEvent }
  | { readonly kind: "turn-error"; readonly error: string }
  | { readonly kind: "terminal-projection"; readonly source: "turnComplete" | "error" | "ended"; readonly outcome: TurnOutcome; readonly assistant: AssistantMaterializationInput; readonly narrative: ParentNarrativeRecoveryItem[] }
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
 * The caller must supply an exact turnExecutionId from provider turn binding;
 * session-level events without that proof belong to a separate owner.
 * The caller must discard this instance if its writer operation fails, because
 * the next event may only observe state whose preceding intents were committed.
 */
export class CodexLiveEventReducer {
  private readonly narrative: NarrativeTurnState;
  private readonly assistant = new AssistantExecutionState();
  private phase: "awaiting-start" | "active" | "completed" | "ended" = "awaiting-start";
  private unknownText = "";
  private knownFinalText = false;
  private compacting = false;
  private readonly plan: PlanExecutionState | null;
  private planTextBytes = 0;
  private planQuestionsResolved = false;

  constructor(readonly execution: ExecutionIdentity, readonly planFeature: CodexPlanFeature = "none") {
    this.narrative = new NarrativeTurnState(execution);
    this.plan = planFeature === "none" ? null : new PlanExecutionState();
    if (planFeature === "questions") this.plan?.beginQuestionGeneration();
    if (planFeature === "output") this.plan?.beginOutputGeneration();
  }

  reduce(input: AgentEvent): CodexLiveReduction {
    const rejection = this.identityRejection(input) ?? UNSUPPORTED_FEATURE_REASON[input.type]
      ?? this.phaseRejection(input) ?? this.textRejection(input) ?? this.planTextRejection(input);
    if (rejection) return this.unsupported(input, rejection);
    let event: AgentEvent;
    try {
      event = structuredClone(input);
    } catch {
      return this.unsupported(input, "event is not cloneable");
    }

    const writer = this.apply(event);
    if (!writer) return this.unsupported(input, "reducer dispatch owner has no handler for this event");
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

  /** Preserve partial text and narrative when the runtime must finish without a provider terminal event. */
  finishFromState(input: SyntheticTerminalInput): CodexLiveReduction {
    const event: AgentEvent = input.outcome === "errored"
      ? { type: "error", threadId: this.execution.threadId, turnExecutionId: this.execution.executionId, error: input.error }
      : { type: "ended", threadId: this.execution.threadId, turnExecutionId: this.execution.executionId, outcome: "interrupted" };
    if (this.phase === "completed" || this.phase === "ended") return this.unsupported(event, "execution already terminal");
    this.phase = "completed";
    const writer: CodexLiveWriterIntent[] = [{ kind: "terminal-projection",
      source: input.outcome === "errored" ? "error" : "ended", outcome: input.outcome,
      assistant: this.assistant.materializationInput(null), narrative: this.narrative.recoverySnapshot(this.execution.threadId) }];
    if (input.outcome === "errored") writer.push({ kind: "turn-error", error: input.error });
    else writer.push({ kind: "turn-ended" });
    return structuredClone({ kind: "reduced", execution: this.execution, writer,
      publication: { event, after: "terminal" } });
  }

  private identityRejection(event: AgentEvent): string | undefined {
    if (event.threadId !== this.execution.threadId) return "different thread";
    if (!event.turnExecutionId) return "event without execution identity needs the provider event routing owner";
    if (event.turnExecutionId !== this.execution.executionId) return "different execution";
    return undefined;
  }

  private phaseRejection(event: AgentEvent): string | undefined {
    if (this.phase === "ended") return "execution already ended";
    if (this.phase === "awaiting-start" && event.type !== "turnStarted" && !BEFORE_START_EVENTS.has(event.type)) {
      return "turn has not started";
    }
    if (this.phase !== "awaiting-start" && event.type === "turnStarted") return "turn already started";
    if (this.phase === "completed") return this.completedPhaseRejection(event);
    if (this.compacting && event.type === "turnComplete") return "turn completion during compaction needs the compaction terminal owner";
    return undefined;
  }

  private completedPhaseRejection(event: AgentEvent): string | undefined {
    if (AFTER_COMPLETION_EVENTS.has(event.type)) return undefined;
    return event.type === "message" ? "post-turn goal receipt needs the goal message owner"
      : "post-terminal event needs the terminal lifecycle owner";
  }

  private textRejection(event: AgentEvent): string | undefined {
    switch (event.type) {
      case "assistantMessageBoundary":
        return !event.isFinalResponse && this.knownFinalText
          ? "mixed final and unknown assistant text" : undefined;
      case "textDelta": return this.deltaRejection(event);
      case "turnComplete":
      case "ended":
      case "error":
        return this.unknownText ? "assistant text still lacks a boundary" : undefined;
      default: return undefined;
    }
  }

  private deltaRejection(event: TextDeltaEvent): string | undefined {
    if (event.isFinalResponse === false && this.knownFinalText) return "mixed final and nonfinal assistant text";
    if (event.isFinalResponse !== undefined && this.unknownText) return "mixed classified and unknown assistant text";
    return undefined;
  }

  private planTextRejection(event: AgentEvent): string | undefined {
    if (!this.plan || this.planQuestionsResolved || event.type !== "textDelta") return undefined;
    return this.planTextBytes + Buffer.byteLength(event.delta, "utf8") > MAX_PLAN_TEXT_BYTES
      ? "plan text exceeds the execution projection limit" : undefined;
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
      case "error": return this.error(event);
      case "ended": return this.ended(event);
      case "contextEstimate": return this.contextEstimate(event);
      case "compacting": return this.compactingEvent(event);
      case "compactSummary": return this.compactSummary(event);
      default: return this.applyStatus(event);
    }
  }

  private applyStatus(event: AgentEvent): CodexLiveWriterIntent[] | undefined {
    if (event.type === "system") return this.system(event);
    // The legacy turn application only publishes these transient statuses.
    return TRANSIENT_STATUS_EVENTS.has(event.type) ? [] : undefined;
  }

  private start(event: Extract<AgentEvent, { type: "turnStarted" }>): CodexLiveWriterIntent[] {
    this.narrative.beginTurn(event.threadId);
    this.narrative.resetTurnCounters(event.threadId);
    this.phase = "active";
    return [{ kind: "turn-started" }];
  }

  private textDelta(event: TextDeltaEvent): CodexLiveWriterIntent[] {
    const writer: CodexLiveWriterIntent[] = [{ kind: "feature-event", feature: "plan-text", event }];
    if (this.plan && !this.planQuestionsResolved) {
      this.planTextBytes += Buffer.byteLength(event.delta, "utf8");
      const ready = this.plan.feedText(event.delta);
      if (ready) {
        this.planQuestionsResolved = true;
        writer.push({ kind: "plan-questions", questions: ready.questions });
      }
    }
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
    const writer: CodexLiveWriterIntent[] = [
      { kind: "assistant-body", content: body.content, model: body.model, attachments: body.attachments, tokens: event.tokens },
      { kind: "feature-event", feature: "assistant-message", event },
    ];
    if (this.plan && this.planFeature === "output") {
      const output = this.plan.consumeAssistantMessage(event.content);
      if (output) writer.push({ kind: "plan-output", output });
    }
    return writer;
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
      ...this.contextUsage(event),
      { kind: "terminal-projection", source: "turnComplete", outcome: "completed",
        assistant: this.assistant.materializationInput(null), narrative: this.narrative.recoverySnapshot(event.threadId) },
      { kind: "feature-event", feature: "goal-refresh", event },
    ];
  }

  private error(event: Extract<AgentEvent, { type: "error" }>): CodexLiveWriterIntent[] {
    this.phase = "completed";
    return [
      { kind: "turn-error", error: event.error },
      { kind: "terminal-projection", source: "error", outcome: "errored",
        assistant: this.assistant.materializationInput(null), narrative: this.narrative.recoverySnapshot(event.threadId) },
    ];
  }

  private contextEstimate(event: Extract<AgentEvent, { type: "contextEstimate" }>): CodexLiveWriterIntent[] {
    return event.totalProcessedTokens === undefined ? [] : this.contextUsage(event);
  }

  private contextUsage(event: ContextEvent): CodexLiveWriterIntent[] {
    return event.tokensIn > 0 && !this.compacting
      ? [{ kind: "context-usage", tokensIn: event.tokensIn,
        ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}) }]
      : [];
  }

  private compactingEvent(event: Extract<AgentEvent, { type: "compacting" }>): CodexLiveWriterIntent[] {
    this.compacting = event.active;
    return [{ kind: event.active ? "compaction-started" : "compaction-divider" }];
  }

  private compactSummary(event: Extract<AgentEvent, { type: "compactSummary" }>): CodexLiveWriterIntent[] {
    this.compacting = false;
    return [{ kind: "compaction-summary", summary: event.summary }];
  }

  private system(event: SystemEvent): CodexLiveWriterIntent[] {
    const writer: CodexLiveWriterIntent[] = [];
    if (event.subtype === "provider.session.started") writer.push({ kind: "notice-session", event });
    if (event.subtype.startsWith("provider.notice.") && event.message) writer.push({ kind: "system-notice", event });
    if (event.subtype.startsWith("sdk_session_id:") || event.subtype === "sdk_session_invalidated") {
      writer.push({ kind: "session-cursor", event });
    }
    return writer;
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
