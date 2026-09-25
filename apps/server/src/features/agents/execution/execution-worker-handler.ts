import type { AgentEvent, ParentNarrativeRecoveryItem, PlanQuestion, PlanRecord, TurnFileEffectSummary, TurnOutcome } from "@mcode/contracts";
import type { ProviderEventDraft } from "@mcode/providers";

import type {
  DataOnlyParentLiveMessageInput,
  DataOnlyParentTerminalProjectionInput,
  DataOnlyParentTurnFinishInput,
  DataOnlyParentTurnStartInput,
} from "../canonical/canonical-parent-turn-write.js";
import type { CodexSystemWriterIntent } from "../canonical/canonical-codex-system-error-projection.js";
import type { CanonicalAgentCommitResult } from "../canonical/canonical-agent-boundary.js";
import type { ProviderEventIngressEvent } from "../../providers/composition/provider-event-ingress.js";
import type {
  ParentAssistantTextCheckpointInput,
  ParentAssistantTextCheckpointResult,
} from "../turns/parent-assistant-text-checkpoint-service.js";
import type { ParentNarrativeRecoveryCommit } from "../turns/parent-turn-durability.js";
import type { TaskToolWriteIntent } from "../tasks/task-tool-intent-reducer.js";
import type { PlanPersistenceReady } from "../planning/plan-execution-state.js";
import type {
  ExecutionIdentity,
  ExecutionLease,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxCommand, ExecutionRecoveryReceipt } from "./execution-mailbox-scheduler.js";
import { ProviderExecutionEventState, type ExecutionParentStartContext, type PreparedProviderLiveEvent } from "./provider-execution-event-state.js";
import { ExecutionWorkerFileEvidence } from "./execution-worker-file-evidence.js";
import type { FrozenExecutionFileEvidence } from "./execution-file-evidence-coordinator.js";
import type { CapturedToolUseObservation, FileTurnHandoff } from "../turns/turn-file-tracker.js";
import type { SyntheticTerminalInput } from "./codex-live-event-reducer.js";

/** Data that an execution worker may receive without a server dependency container. */
export type ExecutionWorkCommand =
  | { readonly kind: "start"; readonly providerId: string; readonly input: DataOnlyParentTurnStartInput; readonly parentLive?: ExecutionParentStartContext; readonly publishParentStart?: boolean; readonly livePublication?: readonly ExecutionLivePublicationIntent[] }
  | { readonly kind: "resume"; readonly providerId: string; readonly checkpointId: string }
  | { readonly kind: "begin-files"; readonly cwd: string; readonly handoff: FileTurnHandoff; readonly deliveryAttempt: number }
  | { readonly kind: "event"; readonly phase: string; readonly nativeCursor: unknown | null; readonly events: readonly ProviderEventDraft[]; readonly parentLive?: ParentLiveEffects; readonly terminalInput?: DataOnlyParentTurnFinishInput; readonly deliveryAttempt?: number; readonly capturedFileObservation?: CapturedToolUseObservation | null; readonly frozenFileEvidence?: FrozenExecutionFileEvidence; readonly livePublication?: readonly ExecutionLivePublicationIntent[] }
  | { readonly kind: "assistant-text"; readonly inputs: readonly ParentAssistantTextCheckpointInput[] }
  | { readonly kind: "narrative-delta"; readonly input: ParentNarrativeRecoveryCommit }
  | {
    readonly kind: "live-event";
    readonly text:
      | { readonly kind: "unchanged" }
      | { readonly kind: "append"; readonly inputs: readonly ParentAssistantTextCheckpointInput[] }
      | { readonly kind: "reclassify"; readonly expectedText: string }
      | { readonly kind: "promote"; readonly input: ParentAssistantTextCheckpointInput };
    readonly narrative?: ParentNarrativeRecoveryCommit;
    readonly taskIntents?: readonly TaskToolWriteIntent[];
    readonly systemIntents?: readonly CodexSystemWriterIntent[];
    readonly message?: DataOnlyParentLiveMessageInput;
    readonly planQuestions?: readonly PlanQuestion[];
    readonly planOutput?: PlanPersistenceReady;
    readonly publication: ExecutionLivePublicationIntent;
  }
  | { readonly kind: "checkpoint"; readonly phase: string; readonly nativeCursor: unknown | null }
  | { readonly kind: "effect-result"; readonly effectId: string; readonly settled: boolean }
  | { readonly kind: "provider-outcome"; readonly outcome: TurnOutcome }
  | { readonly kind: "stage-terminal"; readonly input: DataOnlyParentTerminalProjectionInput }
  | { readonly kind: "finalize"; readonly outcome: TurnOutcome; readonly input: DataOnlyParentTurnFinishInput; readonly livePublication?: readonly ExecutionLivePublicationIntent[] }
  | { readonly kind: "finish-live-event"; readonly outcome: TurnOutcome; readonly projection: DataOnlyParentTerminalProjectionInput; readonly input: DataOnlyParentTurnFinishInput; readonly providerEvent?: TerminalProviderEventInput; readonly frozenFileEvidence?: FrozenExecutionFileEvidence; readonly livePublication?: readonly ExecutionLivePublicationIntent[] }
  | { readonly kind: "finish-from-state"; readonly outcome: SyntheticTerminalInput["outcome"]; readonly input: DataOnlyParentTurnFinishInput; readonly frozenFileEvidence?: FrozenExecutionFileEvidence }
  | ({ readonly kind: "post-terminal-event"; readonly publication: ExecutionLivePublicationIntent } & PostTerminalEffects)
  | { readonly kind: "release"; readonly recovery?: ExecutionRecoveryReceipt };

/** Parent effects prepared from the same provider event as its canonical draft. */
export type ParentLiveEffects = Omit<Extract<ExecutionWorkCommand, { kind: "live-event" }>, "kind" | "publication">;

/** The only effects admitted after an execution's terminal projection has committed. */
export interface PostTerminalEffects {
  readonly hooks?: readonly Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>[];
  readonly systemIntents?: readonly CodexSystemWriterIntent[];
  readonly providerEvent?: TerminalProviderEventInput;
}

/** Provider evidence committed with a terminal projection; synthetic Stop completion omits it. */
export interface TerminalProviderEventInput {
  readonly phase: string;
  readonly nativeCursor: unknown | null;
  readonly events: readonly ProviderEventDraft[];
}

/** One complete semantic mutation. The single writer decides its SQL transaction. */
export interface ExecutionSemanticOperation {
  readonly operationId: string;
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  /** Live Codex events to release with this operation's durable receipt. */
  readonly livePublication?: readonly ExecutionLivePublicationIntent[];
  readonly mutation:
    | { readonly kind: "begin"; readonly providerId: string; readonly input: DataOnlyParentTurnStartInput }
    | { readonly kind: "resume"; readonly providerId: string; readonly checkpointId: string }
    | { readonly kind: "append-events"; readonly phase: string; readonly nativeCursor: unknown | null; readonly events: readonly ProviderEventDraft[]; readonly parentLive?: ParentLiveEffects }
    | { readonly kind: "append-assistant-text"; readonly inputs: readonly ParentAssistantTextCheckpointInput[] }
    | { readonly kind: "narrative-delta"; readonly input: ParentNarrativeRecoveryCommit }
    | {
      readonly kind: "live-event";
      readonly text: Extract<ExecutionWorkCommand, { readonly kind: "live-event" }>["text"];
      readonly narrative?: ParentNarrativeRecoveryCommit;
      readonly taskIntents?: readonly TaskToolWriteIntent[];
      readonly systemIntents?: readonly CodexSystemWriterIntent[];
      readonly message?: DataOnlyParentLiveMessageInput;
      readonly planQuestions?: readonly PlanQuestion[];
      readonly planOutput?: PlanPersistenceReady;
    }
    | { readonly kind: "checkpoint"; readonly phase: string; readonly nativeCursor: unknown | null }
    | { readonly kind: "stop-requested"; readonly requestId: string; readonly lastAdmittedOrdinal: number }
    | { readonly kind: "effect-result"; readonly effectId: string; readonly settled: boolean }
    | { readonly kind: "provider-outcome"; readonly outcome: TurnOutcome }
    | { readonly kind: "stage-terminal"; readonly input: DataOnlyParentTerminalProjectionInput }
    | { readonly kind: "worker-lost"; readonly reason: string; readonly recoveryIncidentId: string }
    | { readonly kind: "finish"; readonly outcome: TurnOutcome; readonly input: DataOnlyParentTurnFinishInput }
    | { readonly kind: "finish-live-event"; readonly outcome: TurnOutcome; readonly projection: DataOnlyParentTerminalProjectionInput; readonly input: DataOnlyParentTurnFinishInput; readonly providerEvent?: TerminalProviderEventInput }
    | ({ readonly kind: "post-terminal-event" } & PostTerminalEffects);
}

/** A live event has one durability barrier and stays inert until its semantic effects commit. */
export interface ExecutionLivePublicationIntent {
  readonly event: AgentEvent;
  readonly after: "writer" | "terminal";
}

/** Stable identity lets the transport deduplicate a replayed publication receipt. */
export interface ExecutionLivePublicationReceipt extends ExecutionLivePublicationIntent {
  readonly publicationId: string;
}

/** Plan questions may be pushed only after their text event's durable writer receipt. */
export interface ExecutionPlanQuestionsReceipt {
  readonly publicationId: string;
  readonly threadId: string;
  readonly questions: readonly PlanQuestion[];
}

/** Provider-facing receipt values retained with the execution operation. */
export type ExecutionProviderCommitReceipt = Pick<
  CanonicalAgentCommitResult,
  "outcome" | "conversationRevision" | "rosterRevision" | "acceptedThrough" | "durableThrough"
> & { readonly eventCount: number };

/** A committed runtime event after writer-local provider interpretation. */
export type ProjectedCommittedProviderEvent = Omit<
  ProviderEventIngressEvent,
  "sourceKind" | "canonicalReceipt" | "runtimeExtension"
> & {
  readonly sourceKind: "canonical-commit";
  readonly canonicalReceipt: NonNullable<ProviderEventIngressEvent["canonicalReceipt"]>;
};

/** Writer-confirmed terminal projection surfaced after its durable finish. */
export interface ExecutionTerminalPersistenceReceipt {
  readonly messageId: string | null;
  readonly outcome: TurnOutcome;
  readonly toolCallCount: number;
  readonly filesChanged: readonly string[];
  readonly fileEffects?: TurnFileEffectSummary;
}

/** A writer reply is valid only after the semantic operation commits durably. */
export type ExecutionWriteReceipt =
  | { readonly kind: "committed"; readonly operationId: string; readonly durableRevision: number; readonly providerCommit?: ExecutionProviderCommitReceipt; readonly providerEvents?: readonly ProjectedCommittedProviderEvent[]; readonly assistantTextCheckpoint?: ParentAssistantTextCheckpointResult; readonly livePublication?: readonly ExecutionLivePublicationReceipt[]; readonly planQuestions?: ExecutionPlanQuestionsReceipt; readonly planOutput?: PlanRecord; readonly terminalPersistence?: ExecutionTerminalPersistenceReceipt }
  | { readonly kind: "conflict"; readonly operationId: string; readonly recoveryState?: "not-started" | "already-terminal" };

/**
 * Implemented by one acknowledged writer, not by a worker-local SQLite connection.
 * It must fence the durable lease and enforce terminal prerequisites in the
 * same transaction that records each semantic operation.
 */
export interface ExecutionSemanticWriter {
  transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt>;
}

/** Execution runtime effects returned only after their associated parent write commits. */
export type ExecutionParentEventResult = Pick<PreparedProviderLiveEvent, "runtime" | "publication" | "terminal">;

/** A command result that never calls an uncommitted mutation successful. */
export type ExecutionWorkerResult =
  | { readonly kind: "committed"; readonly operationId: string; readonly durableRevision: number; readonly providerCommit?: ExecutionProviderCommitReceipt; readonly providerEvents?: readonly ProjectedCommittedProviderEvent[]; readonly assistantTextCheckpoint?: ParentAssistantTextCheckpointResult; readonly livePublication?: readonly ExecutionLivePublicationReceipt[]; readonly planQuestions?: ExecutionPlanQuestionsReceipt; readonly planOutput?: PlanRecord; readonly terminalPersistence?: ExecutionTerminalPersistenceReceipt; readonly parentEvent?: ExecutionParentEventResult }
  | { readonly kind: "released" }
  | { readonly kind: "rejected"; readonly reason: "no-execution" | "stale-execution" | "out-of-order" | "invalid-transition" | "invalid-event-routing" | "invalid-text-routing" | "invalid-narrative-routing" | "invalid-stop-watermark" | "writer-conflict" | "writer-failure" };

type WorkerCommand = ExecutionMailboxCommand<ExecutionWorkCommand>;
const METADATA_MUTATIONS: ReadonlySet<WorkerCommand["kind"]> = new Set([
  "checkpoint", "effect-result", "provider-outcome", "stage-terminal",
]);

interface ExecutionState {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly providerId: string;
  readonly parentEvents?: ProviderExecutionEventState;
  nextOrdinal: number;
  phase: "running" | "stopping" | "finalized" | "poisoned";
  durableRevision: number;
  fileAttempt?: number;
}

interface PreparedExecutionRequest {
  readonly request: ExecutionWorkerRequest<WorkerCommand>;
  readonly parentEvent?: ExecutionParentEventResult;
}

/**
 * Applies one worker command at a time per slot. This module has no database
 * handle, provider process, or publication callback. It only advances state
 * after the single writer acknowledges the semantic operation.
 */
export class ExecutionWorkerHandler {
  private readonly states = new Map<string, ExecutionState>();

  constructor(private readonly writer: ExecutionSemanticWriter, private readonly files = new ExecutionWorkerFileEvidence()) {}

  /** Whether every execution assigned to this worker has released its state. */
  get isIdle(): boolean { return this.states.size === 0; }

  /** Process one mailbox command and echo its exact execution and lease. */
  async handle(request: ExecutionWorkerRequest<WorkerCommand>): Promise<ExecutionWorkerReply<ExecutionWorkerResult>> {
    const result = await this.apply(request);
    return {
      requestId: request.requestId,
      execution: request.execution,
      lease: request.lease,
      ordinal: request.ordinal,
      result,
    };
  }

  private async apply(request: ExecutionWorkerRequest<WorkerCommand>): Promise<ExecutionWorkerResult> {
    const state = this.states.get(request.execution.threadId);
    if (request.command.kind === "start" || request.command.kind === "resume") {
      return await this.begin(request, state);
    }
    if (!state) return { kind: "rejected", reason: "no-execution" };
    return await this.applyToState(request, state);
  }

  private async applyToState(
    request: ExecutionWorkerRequest<WorkerCommand>,
    state: ExecutionState,
  ): Promise<ExecutionWorkerResult> {
    const rejection = commandRejection(request, state);
    if (rejection) return { kind: "rejected", reason: rejection };
    if (request.command.kind === "release") return this.release(request, state);
    if (state.phase === "poisoned" || state.phase === "finalized"
      && request.command.kind !== "event" && request.command.kind !== "post-terminal-event") {
      return { kind: "rejected", reason: "invalid-transition" };
    }
    const prepared = await this.prepareOwnedRequest(request, state);
    if (!prepared) return { kind: "rejected", reason: "invalid-event-routing" };
    const mutation = mutationFor(prepared.request, state);
    if (!mutation) {
      if (prepared.parentEvent) state.phase = "poisoned";
      return { kind: "rejected", reason: invalidReason(request) };
    }
    return await this.commitRequest(prepared, state, mutation);
  }

  private async prepareOwnedRequest(request: ExecutionWorkerRequest<WorkerCommand>, state: ExecutionState): Promise<PreparedExecutionRequest | undefined> {
    try {
      const prepared = this.prepareRequest(request, state);
      if (!prepared) return undefined;
      const withFiles = await this.prepareFileEffects(prepared, state);
      if (!withFiles && prepared.parentEvent) state.phase = "poisoned";
      return withFiles;
    } catch (error) {
      if (state.parentEvents) state.phase = "poisoned";
      throw error;
    }
  }

  private async commitRequest(
    prepared: PreparedExecutionRequest,
    state: ExecutionState,
    mutation: ExecutionSemanticOperation["mutation"],
  ): Promise<ExecutionWorkerResult> {
    const { request } = prepared;
    let receipt: ExecutionWriteReceipt;
    try {
      receipt = await this.writer.transact(operationFor(request, mutation));
    } catch (error) {
      if (state.parentEvents) state.phase = "poisoned";
      throw error;
    }
    if (!isDurableReceipt(receipt, request, state.durableRevision)) {
      if (state.parentEvents) state.phase = "poisoned";
      return { kind: "rejected", reason: "writer-conflict" };
    }
    state.nextOrdinal += 1;
    state.durableRevision = receipt.durableRevision;
    if (request.command.kind === "stop") state.phase = "stopping";
    if (request.command.kind === "finalize" || request.command.kind === "finish-live-event") {
      state.phase = "finalized";
      if (state.fileAttempt !== undefined) this.files.retire(state.execution, state.fileAttempt);
    }
    const result = committedResult(receipt);
    return prepared.parentEvent ? { ...result, parentEvent: prepared.parentEvent } : result;
  }

  private prepareRequest(request: ExecutionWorkerRequest<WorkerCommand>, state: ExecutionState): PreparedExecutionRequest | undefined {
    const command = request.command;
    if (command.kind === "finish-from-state") return this.prepareSyntheticFinish(request, command, state);
    if (!state.parentEvents || command.kind !== "event") return { request };
    if (state.phase === "finalized") return this.preparePostTerminalEvent(request, command, state);
    if (!validOwnedEventCommand(command, state)) return undefined;
    const reduction = state.parentEvents.prepare(command.events, command.terminalInput !== undefined);
    if (reduction.kind === "rejected") return undefined;
    if (reduction.kind === "writer-owned") return { request };
    const { effects, ...parentEvent } = reduction.prepared;
    if (parentEvent.publication.after === "terminal") {
      const terminal = prepareTerminalEvent(command, parentEvent, state.providerId);
      if (!terminal) { state.phase = "poisoned"; return undefined; }
      return { request: { ...request, command: terminal }, parentEvent };
    }
    return { request: { ...request, command: { ...command,
      parentLive: effects, livePublication: [parentEvent.publication] } }, parentEvent };
  }


  private prepareSyntheticFinish(
    request: ExecutionWorkerRequest<WorkerCommand>,
    command: Extract<WorkerCommand, { kind: "finish-from-state" }>,
    state: ExecutionState,
  ): PreparedExecutionRequest | undefined {
    const terminalInput = syntheticTerminalInput(command, state);
    if (!terminalInput || !state.parentEvents) return undefined;
    const reduction = state.parentEvents.finishFromState(terminalInput);
    if (reduction.kind !== "parent" || !reduction.prepared.terminal) return undefined;
    const { effects: _effects, ...parentEvent } = reduction.prepared;
    const projection = reduction.prepared.terminal;
    const finish: Extract<ExecutionWorkCommand, { kind: "finish-live-event" }> = {
      kind: "finish-live-event", outcome: command.outcome, projection,
      input: { ...command.input, projection: { kind: "writer-staged",
        ...(projection.assistant.messageId ? { messageId: projection.assistant.messageId } : {}) } },
      ...(command.frozenFileEvidence ? { frozenFileEvidence: command.frozenFileEvidence } : {}),
      livePublication: [parentEvent.publication],
    };
    return { request: { ...request, command: finish }, parentEvent };
  }

  private preparePostTerminalEvent(
    request: ExecutionWorkerRequest<WorkerCommand>,
    command: Extract<WorkerCommand, { kind: "event" }>,
    state: ExecutionState,
  ): PreparedExecutionRequest | undefined {
    if (!validLateOwnedEventCommand(command, state) || !state.parentEvents) return undefined;
    const reduction = state.parentEvents.prepare(command.events, true);
    if (reduction.kind !== "parent" || reduction.prepared.terminal) return undefined;
    const { effects, ...prepared } = reduction.prepared;
    const parentEvent = { ...prepared, publication: { ...prepared.publication, after: "terminal" as const } };
    const hooks = effects.narrative?.items.filter((item) => item.kind === "hook");
    return { parentEvent, request: { ...request, command: {
      kind: "post-terminal-event", publication: parentEvent.publication,
      ...(hooks?.length ? { hooks } : {}), ...(effects.systemIntents ? { systemIntents: effects.systemIntents } : {}),
      providerEvent: { phase: command.phase, nativeCursor: command.nativeCursor, events: command.events },
    } } };
  }

  private async prepareFileEffects(prepared: PreparedExecutionRequest, state: ExecutionState): Promise<PreparedExecutionRequest | undefined> {
    const command = prepared.request.command;
    if (command.kind === "begin-files") {
      return this.beginFileEffects(command, state) ? prepared : undefined;
    }
    if (command.kind === "finish-live-event") {
      if (state.fileAttempt !== undefined) return this.prepareTerminalFiles(prepared, command, state);
      return command.frozenFileEvidence ? undefined : prepared;
    }
    if (command.kind !== "event" || state.fileAttempt === undefined) return prepared;
    return await this.observeEventFiles(prepared, command, state) ? prepared : undefined;
  }

  private beginFileEffects(command: Extract<WorkerCommand, { kind: "begin-files" }>, state: ExecutionState): boolean {
    if (!state.parentEvents || state.nextOrdinal !== 2 || !this.files.begin({
      execution: state.execution, deliveryAttempt: command.deliveryAttempt, cwd: command.cwd, handoff: command.handoff,
    })) return false;
    state.fileAttempt = command.deliveryAttempt;
    return true;
  }

  private async observeEventFiles(
    prepared: PreparedExecutionRequest,
    command: Extract<WorkerCommand, { kind: "event" }>,
    state: ExecutionState,
  ): Promise<boolean> {
    if (state.fileAttempt === undefined) return false;
    const event = prepared.parentEvent?.publication.event;
    if (event?.type === "toolUse" && command.capturedFileObservation) {
      return this.files.observeToolUse({ execution: state.execution, deliveryAttempt: state.fileAttempt,
        event, captured: command.capturedFileObservation });
    }
    if (event?.type === "toolResult") await this.files.observeToolResult({
      execution: state.execution, deliveryAttempt: state.fileAttempt, event,
    });
    return true;
  }

  private async prepareTerminalFiles(
    prepared: PreparedExecutionRequest,
    command: Extract<WorkerCommand, { kind: "finish-live-event" }>,
    state: ExecutionState,
  ): Promise<PreparedExecutionRequest | undefined> {
    const frozen = command.frozenFileEvidence;
    if (!frozen || frozen.outcome !== command.outcome || frozen.deliveryAttempt !== state.fileAttempt) return undefined;
    const evidence = await this.files.settle(frozen);
    if (!evidence) return undefined;
    return { ...prepared, request: { ...prepared.request, command: { ...command,
      input: { ...command.input, deliveryAttempt: state.fileAttempt, fileEvidence: evidence } } } };
  }

  private async begin(
    request: ExecutionWorkerRequest<WorkerCommand>,
    existing: ExecutionState | undefined,
  ): Promise<ExecutionWorkerResult> {
    const rejection = beginRejection(request, existing);
    if (rejection) return { kind: "rejected", reason: rejection };
    const command = request.command;
    if (command.kind !== "start" && command.kind !== "resume") throw new Error("Invalid begin command escaped validation");
    const parent = parentReducerState(command, request.execution);
    const started = this.admissionStart(command, parent);
    const receipt = await this.writer.transact(operationFor(
      withParentStartPublication(request, started), beginMutation(command),
    ));
    if (!isDurableReceipt(receipt, request, 0)) {
      return { kind: "rejected", reason: "writer-conflict" };
    }
    this.states.set(request.execution.threadId, {
      execution: request.execution,
      lease: request.lease,
      providerId: command.providerId,
      ...parent,
      nextOrdinal: 2,
      phase: "running",
      durableRevision: receipt.durableRevision,
    });
    return started
      ? { ...committedResult(receipt), parentEvent: started }
      : committedResult(receipt);
  }

  private admissionStart(
    command: Extract<ExecutionWorkCommand, { kind: "start" | "resume" }>,
    parent: Pick<ExecutionState, "parentEvents">,
  ): PreparedProviderLiveEvent | undefined {
    if (command.kind !== "start" || !command.publishParentStart) return undefined;
    const started = parent.parentEvents?.startFromAdmission();
    if (started?.kind !== "parent" || started.prepared.publication.event.type !== "turnStarted") {
      throw new Error("Worker-owned parent start could not be prepared");
    }
    return started.prepared;
  }

  private release(request: ExecutionWorkerRequest<WorkerCommand>, state: ExecutionState): ExecutionWorkerResult {
    if (state.phase !== "finalized" && !validRecoveryRelease(request.command, state.lease)) {
      return { kind: "rejected", reason: "invalid-transition" };
    }
    if (state.fileAttempt !== undefined) this.files.retire(state.execution, state.fileAttempt);
    this.states.delete(request.execution.threadId);
    return { kind: "released" };
  }
}

function beginRejection(
  request: ExecutionWorkerRequest<WorkerCommand>,
  existing: ExecutionState | undefined,
): "invalid-transition" | "out-of-order" | null {
  if (existing) return "invalid-transition";
  if (request.ordinal !== 1) return "out-of-order";
  const command = request.command;
  if (command.kind !== "start" && command.kind !== "resume") return "invalid-transition";
  return command.kind === "start" && !validStartInput(command, request.execution)
    ? "invalid-transition" : null;
}

function beginMutation(command: Extract<ExecutionWorkCommand, { kind: "start" | "resume" }>): ExecutionSemanticOperation["mutation"] {
  return command.kind === "start"
    ? { kind: "begin", providerId: command.providerId, input: command.input }
    : { kind: "resume", providerId: command.providerId, checkpointId: command.checkpointId };
}

function withParentStartPublication(
  request: ExecutionWorkerRequest<WorkerCommand>,
  started: PreparedProviderLiveEvent | undefined,
): ExecutionWorkerRequest<WorkerCommand> {
  return started && request.command.kind === "start"
    ? { ...request, command: { ...request.command, livePublication: [started.publication] } }
    : request;
}

function mutationFor(
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  const command = request.command;
  switch (command.kind) {
    case "post-terminal-event": {
      if (state.phase !== "finalized") return undefined;
      const { publication: _publication, ...mutation } = command;
      return mutation;
    }
    case "event":
      return eventMutation(command, request.execution, state);
    case "narrative-delta":
      return narrativeMutation(command, request.execution, state);
    case "live-event":
      return liveEventMutation(command, request.execution, state);
    case "stop":
      return stopMutation(command, request, state);
    case "finalize":
    case "finish-live-event":
      return finishMutation(command, request.execution, state.providerId);
    default: return auxiliaryMutation(command, request.execution, state);
  }
}

function auxiliaryMutation(
  command: Extract<WorkerCommand, { kind: "begin-files" | "start" | "resume" | "release" | "finish-from-state" | "assistant-text" | "checkpoint" | "effect-result" | "provider-outcome" | "stage-terminal" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (command.kind === "start" || command.kind === "resume" || command.kind === "release" || command.kind === "finish-from-state") return undefined;
  // File handoff is the first command after durable start, before a provider cursor exists.
  if (command.kind === "begin-files") return { kind: "checkpoint", phase: "running", nativeCursor: null };
  return metadataOrTextMutation(command, execution, state);
}

function syntheticTerminalInput(
  command: Extract<WorkerCommand, { kind: "finish-from-state" }>,
  state: ExecutionState,
): SyntheticTerminalInput | undefined {
  if (state.phase !== "running" && state.phase !== "stopping") return undefined;
  if (command.input.outcome !== command.outcome || command.input.providerId !== state.providerId
    || !sameIdentity(command.input, state.execution)) return undefined;
  switch (command.outcome) {
    case "cancelled": return { outcome: "cancelled" };
    case "interrupted": return { outcome: "interrupted" };
    case "errored": return errorTerminalInput(command.input.error);
  }
}

function errorTerminalInput(error: unknown): Extract<SyntheticTerminalInput, { outcome: "errored" }> | undefined {
  return typeof error === "string" && error.length > 0 ? { outcome: "errored", error } : undefined;
}

function validOwnedEventCommand(command: Extract<WorkerCommand, { kind: "event" }>, state: ExecutionState): boolean {
  return command.parentLive === undefined && command.livePublication === undefined && state.phase === "running"
    && (state.fileAttempt === undefined || command.deliveryAttempt === state.fileAttempt);
}

function validLateOwnedEventCommand(command: Extract<WorkerCommand, { kind: "event" }>, state: ExecutionState): boolean {
  return command.parentLive === undefined && command.livePublication === undefined
    && (state.fileAttempt === undefined || command.deliveryAttempt === state.fileAttempt);
}

function metadataOrTextMutation(
  command: Extract<WorkerCommand, { kind: "assistant-text" | "checkpoint" | "effect-result" | "provider-outcome" | "stage-terminal" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (isMetadataMutation(command)) return command;
  return state.phase === "running" && validTextRouting(command.inputs, execution)
    ? { kind: "append-assistant-text", inputs: command.inputs } : undefined;
}

function isMetadataMutation(command: WorkerCommand): command is Extract<
  WorkerCommand,
  { readonly kind: "checkpoint" | "effect-result" | "provider-outcome" | "stage-terminal" }
> {
  return METADATA_MUTATIONS.has(command.kind);
}

function eventMutation(
  command: Extract<WorkerCommand, { kind: "event" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || !validEventRouting(command.events, execution)
    || (command.parentLive !== undefined && (!validLiveEventRouting(command.parentLive, execution)
      || command.livePublication?.length !== 1))) return undefined;
  return {
    kind: "append-events", phase: command.phase, nativeCursor: command.nativeCursor, events: command.events,
    ...(command.parentLive ? { parentLive: command.parentLive } : {}),
  };
}

function narrativeMutation(
  command: Extract<WorkerCommand, { kind: "narrative-delta" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || command.input?.executionId !== execution.executionId) return undefined;
  return { kind: "narrative-delta", input: command.input };
}

function liveEventMutation(
  command: Extract<WorkerCommand, { kind: "live-event" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || !validLiveEventRouting(command, execution)) return undefined;
  return {
    kind: "live-event", text: command.text,
    ...(command.narrative ? { narrative: command.narrative } : {}),
    ...(command.taskIntents ? { taskIntents: command.taskIntents } : {}),
    ...(command.systemIntents ? { systemIntents: command.systemIntents } : {}),
    ...(command.message ? { message: command.message } : {}),
    ...(command.planQuestions ? { planQuestions: command.planQuestions } : {}),
    ...(command.planOutput ? { planOutput: command.planOutput } : {}),
  };
}

function stopMutation(
  command: Extract<WorkerCommand, { kind: "stop" }>,
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || request.stopWatermark !== request.ordinal - 1) return undefined;
  return { kind: "stop-requested", requestId: command.requestId, lastAdmittedOrdinal: request.stopWatermark };
}

function finishMutation(
  command: Extract<WorkerCommand, { kind: "finalize" | "finish-live-event" }>,
  execution: ExecutionIdentity,
  providerId: string,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (!validFinishInput(command, execution, providerId)) return undefined;
  if (command.kind === "finish-live-event") {
    if (command.projection.threadId !== execution.threadId || command.projection.executionId !== execution.executionId
      || command.projection.outcome !== command.outcome) return undefined;
    if (command.providerEvent && !validEventRouting(command.providerEvent.events, execution)) return undefined;
    return { kind: "finish-live-event", outcome: command.outcome, projection: command.projection, input: command.input,
      ...(command.providerEvent ? { providerEvent: command.providerEvent } : {}) };
  }
  return { kind: "finish", outcome: command.outcome, input: command.input };
}

function commandRejection(
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): Extract<ExecutionWorkerResult, { kind: "rejected" }>["reason"] | null {
  if (!sameIdentity(state.execution, request.execution) || !sameLease(state.lease, request.lease)) return "stale-execution";
  if (validRecoveryRelease(request.command, state.lease)) return null;
  if (request.ordinal !== state.nextOrdinal) return "out-of-order";
  return null;
}

function validRecoveryRelease(command: WorkerCommand, lease: ExecutionLease): boolean {
  if (command.kind !== "release" || !command.recovery
    || command.recovery.operationId !== `${lease.leaseId}:worker-lost`) return false;
  return command.recovery.kind === "committed" && Number.isSafeInteger(command.recovery.durableRevision)
    || command.recovery.kind === "conflict" && command.recovery.recoveryState === "already-terminal";
}

function invalidReason(request: ExecutionWorkerRequest<WorkerCommand>): Extract<ExecutionWorkerResult, { kind: "rejected" }>["reason"] {
  if (request.command.kind === "stop" && request.stopWatermark !== request.ordinal - 1) return "invalid-stop-watermark";
  if (request.command.kind === "live-event") {
    return invalidLiveEventReason(request.command, request.execution) ?? "invalid-transition";
  }
  return invalidRoutingReason(request.command, request.execution) ?? "invalid-transition";
}

function invalidRoutingReason(
  command: Exclude<WorkerCommand, { kind: "live-event" }>,
  execution: ExecutionIdentity,
): "invalid-event-routing" | "invalid-text-routing" | "invalid-narrative-routing" | null {
  switch (command.kind) {
    case "event":
      return invalidEventRoutingReason(command, execution);
    case "assistant-text":
      return validTextRouting(command.inputs, execution) ? null : "invalid-text-routing";
    case "narrative-delta":
      return command.input?.executionId === execution.executionId ? null : "invalid-narrative-routing";
    default:
      return null;
  }
}

function invalidLiveEventReason(
  command: Extract<WorkerCommand, { kind: "live-event" }>,
  execution: ExecutionIdentity,
): "invalid-text-routing" | "invalid-narrative-routing" | null {
  if (validLiveEventRouting(command, execution)) return null;
  return command.narrative !== undefined && command.narrative?.executionId !== execution.executionId
    ? "invalid-narrative-routing" : "invalid-text-routing";
}

function validEventRouting(events: readonly ProviderEventDraft[], execution: ExecutionIdentity): boolean {
  return events.length > 0 && events.every((event) => event.routing.threadId === execution.threadId
    && event.routing.turnId === execution.turnId && event.routing.executionId === execution.executionId);
}

function validTextRouting(inputs: readonly ParentAssistantTextCheckpointInput[], execution: ExecutionIdentity): boolean {
  return Array.isArray(inputs) && inputs.length > 0 && inputs.every((input) => input
    && input.threadId === execution.threadId
    && input.turnId === execution.turnId && input.executionId === execution.executionId);
}

function validLiveEventRouting(
  command: ParentLiveEffects,
  execution: ExecutionIdentity,
): boolean {
  if (command.narrative !== undefined && command.narrative?.executionId !== execution.executionId) return false;
  if (!validPlanMessageRouting(command)) return false;
  switch (command.text?.kind) {
    case "unchanged":
    case "reclassify":
      return true;
    case "append":
      return validTextRouting(command.text.inputs, execution);
    case "promote":
      return validTextRouting([command.text.input], execution);
    default:
      return false;
  }
}

function validPlanMessageRouting(command: ParentLiveEffects): boolean {
  return command.planOutput === undefined || command.message !== undefined;
}

function validStartInput(
  command: Extract<ExecutionWorkCommand, { kind: "start" }>,
  execution: ExecutionIdentity,
): boolean {
  return command.providerId === command.input.thread.providerId
    && command.input.thread.id === execution.threadId
    && command.input.turnId === execution.turnId
    && command.input.executionId === execution.executionId
    && validParentStartContext(command);
}

function invalidEventRoutingReason(
  command: Extract<ExecutionWorkCommand, { kind: "event" }>,
  execution: ExecutionIdentity,
): "invalid-event-routing" | "invalid-text-routing" | null {
  if (!validEventRouting(command.events, execution)) return "invalid-event-routing";
  return command.parentLive !== undefined && (!validLiveEventRouting(command.parentLive, execution)
    || command.livePublication?.length !== 1) ? "invalid-text-routing" : null;
}

function parentReducerState(
  command: Extract<ExecutionWorkCommand, { kind: "start" | "resume" }>,
  execution: ExecutionIdentity,
): Pick<ExecutionState, "parentEvents"> {
  if (command.kind !== "start" || !command.parentLive) return {};
  switch (command.providerId) {
    case "codex": return { parentEvents: new ProviderExecutionEventState("codex", execution, command.parentLive) };
    case "claude": return { parentEvents: new ProviderExecutionEventState("claude", execution, command.parentLive) };
    case "cursor": return { parentEvents: new ProviderExecutionEventState("cursor", execution, command.parentLive) };
    default: throw new Error("Unsupported execution parent provider");
  }
}

function validParentStartContext(command: Extract<ExecutionWorkCommand, { kind: "start" }>): boolean {
  const context = command.parentLive;
  if (!context) return true;
  return supportedParentProvider(command.providerId) && typeof context.precedingMessageId === "string"
    && context.precedingMessageId.length > 0 && context.precedingMessageId === command.input.userMessage.messageId
    && (context.planFeature === "none" || context.planFeature === "questions" || context.planFeature === "output");
}

function supportedParentProvider(providerId: string): boolean {
  return providerId === "codex" || providerId === "claude" || providerId === "cursor";
}

function prepareTerminalEvent(
  command: Extract<ExecutionWorkCommand, { kind: "event" }>,
  parentEvent: ExecutionParentEventResult,
  providerId: string,
): Extract<ExecutionWorkCommand, { kind: "finish-live-event" }> | undefined {
  const projection = parentEvent.terminal;
  const input = command.terminalInput;
  if (!projection || !input || input.outcome !== projection.outcome || input.providerId !== providerId
    || input.threadId !== projection.threadId || input.executionId !== projection.executionId) return undefined;
  return { kind: "finish-live-event", outcome: projection.outcome, projection,
    input: { ...input, ...(parentEvent.publication.event.type === "error" ? { error: parentEvent.publication.event.error } : {}),
      projection: { kind: "writer-staged",
      ...(projection.assistant.messageId ? { messageId: projection.assistant.messageId } : {}) } },
    providerEvent: { phase: command.phase, nativeCursor: command.nativeCursor, events: command.events },
    ...(command.frozenFileEvidence ? { frozenFileEvidence: command.frozenFileEvidence } : {}),
    livePublication: [parentEvent.publication] };
}

function validFinishInput(
  command: Extract<ExecutionWorkCommand, { kind: "finalize" | "finish-live-event" }>,
  execution: ExecutionIdentity,
  providerId: string,
): boolean {
  return command.outcome === command.input.outcome
    && command.input.providerId === providerId
    && command.input.threadId === execution.threadId
    && command.input.turnId === execution.turnId
    && command.input.executionId === execution.executionId;
}

function operationFor(
  request: ExecutionWorkerRequest<WorkerCommand>,
  mutation: ExecutionSemanticOperation["mutation"],
): ExecutionSemanticOperation {
  const livePublication = livePublicationFor(request.command);
  return {
    operationId: operationId(request),
    execution: request.execution,
    lease: request.lease,
    ordinal: request.ordinal,
    mutation,
    ...(livePublication ? { livePublication } : {}),
  };
}

function livePublicationFor(command: WorkerCommand): readonly ExecutionLivePublicationIntent[] | undefined {
  switch (command.kind) {
    case "start":
    case "event":
    case "finish-live-event":
    case "finalize": return command.livePublication;
    case "live-event": return [command.publication];
    case "post-terminal-event": return [command.publication];
    default: return undefined;
  }
}

function operationId(request: ExecutionWorkerRequest<WorkerCommand>): string {
  return `${request.lease.leaseId}:${request.ordinal}`;
}

function isDurableReceipt(
  receipt: ExecutionWriteReceipt,
  request: ExecutionWorkerRequest<WorkerCommand>,
  previousRevision: number,
): receipt is Extract<ExecutionWriteReceipt, { kind: "committed" }> {
  return receipt.kind === "committed" && receipt.operationId === operationId(request)
    && Number.isSafeInteger(receipt.durableRevision) && receipt.durableRevision >= previousRevision;
}

function committedResult(receipt: Extract<ExecutionWriteReceipt, { kind: "committed" }>): Extract<ExecutionWorkerResult, { kind: "committed" }> {
  return {
    kind: "committed", operationId: receipt.operationId, durableRevision: receipt.durableRevision,
    ...(receipt.providerCommit ? { providerCommit: receipt.providerCommit } : {}),
    ...(receipt.providerEvents ? { providerEvents: receipt.providerEvents } : {}),
    ...(receipt.assistantTextCheckpoint ? { assistantTextCheckpoint: receipt.assistantTextCheckpoint } : {}),
    ...(receipt.livePublication ? { livePublication: receipt.livePublication } : {}),
    ...(receipt.planQuestions ? { planQuestions: receipt.planQuestions } : {}),
    ...(receipt.planOutput ? { planOutput: receipt.planOutput } : {}),
    ...(receipt.terminalPersistence ? { terminalPersistence: receipt.terminalPersistence } : {}),
  };
}

function sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId && left.executionId === right.executionId;
}

function sameLease(left: ExecutionLease, right: ExecutionLease): boolean {
  return left.ownerEpoch === right.ownerEpoch && left.workerIndex === right.workerIndex
    && left.workerGeneration === right.workerGeneration && left.leaseId === right.leaseId;
}
