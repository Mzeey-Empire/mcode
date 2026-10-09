import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import {
  AcceptedCanonicalAgentEventEnvelopeSchema, reduceAgentEventBatch,
  type AcceptedCanonicalAgentEventEnvelope, type AgentModelState, type AgentProgressPosition,
  type CanonicalAgentProgressRecovery, type CanonicalAgentRevision, type TurnSavingStatus,
  type CanonicalAgentEventEnvelope,
  type Message, type CanonicalAgentProgressFrame,
  type AgentEvent,
  type CanonicalSubagentRosterRequest, type CanonicalSubagentStopRequest, type CollaborationObservationChange,
  AgentEventSchema,
  MessageSchema, HookExecutionRecordSchema,
  PlanRecordSchema, type PlanRecord, type PlanStatus,
} from "@mcode/contracts";
import { broadcast, subscribedThreadIds } from "../../../application/transport/push.js";
import { BoundedProgressRetention } from "../execution/progress-retention-budget.js";
import { ThreadProgressOwner } from "../execution/thread-progress-owner.js";
import type { AcceptedProgressBatch, SavedProgressReceipt, ProgressSaveFailure } from "../execution/thread-progress-types.js";
import type { ExecutionAcceptedReceipt, ExecutionSemanticOperation } from "../execution/execution-worker-handler.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";
import { syntheticThreadExecutionId } from "./canonical-thread-execution.js";
import { CanonicalWriterAcknowledgementCapacity, type CanonicalAgentWriterClient } from "./canonical-agent-writer-client.js";
import type { CanonicalAcceptedWriteReceipt } from "./canonical-agent-writer-protocol.js";
import type { CanonicalAcceptedWriteInput } from "./canonical-accepted-write.js";
import { AcceptedSaveScheduler } from "./accepted-save-scheduler.js";
import { prepareAcceptedParentEvents } from "./accepted-parent-events.js";
import { acceptedNarrative, advanceAcceptedExecution, seedAcceptedExecution, type AcceptedExecutionState } from "./accepted-execution-state.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";
import { sameExecution, sameLease } from "../execution/execution-mailbox-protocol.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import { ProgressAdmissionError, RejectedProviderObservationError } from "../execution/execution-writer-failure.js";
import { prepareAcceptedCollaboration } from "./accepted-collaboration-preparation.js";
import { AcceptedCodexCollaboration } from "./accepted-codex-collaboration.js";
import type { SubagentStopTarget } from "../collaboration/subagent-lifecycle-durability.js";
import type { CreateHookExecutionInput } from "../events/persistence/hook-execution-repo.js";
import * as NodeUtil from "node:util";
import { z } from "zod";
import { prepareAcceptedFeatureObservations, prepareAcceptedThreadSystemFeatures, type AcceptedFeatureObservations, type AcceptedChildPublicationOwner } from "./accepted-feature-observations.js";
import type { AcceptedFeatureWriteMetadata } from "./accepted-feature-write.js";
import { notifyCommittedCanonicalEvents } from "./committed-canonical-events.js";
import type { StoredTask } from "../orchestration/persistence/task-repo.js";

type AcceptedExecutionWriteIntent = ({ readonly kind: "execution"; readonly operation: ExecutionSemanticOperation }
  | { readonly kind: "plan-answer"; readonly assistant: Message }
  | { readonly kind: "control" }) & {
  readonly phase: string;
  readonly nativeCursor: unknown | null;
  readonly features?: AcceptedFeatureWriteMetadata;
};

const MAX_OWNERS = 8;
const LOCAL_LIMITS = { maxEvents: 8_192, maxBytes: 16 * 1024 * 1024,
  reservedControlEvents: 4_096, reservedControlBytes: 8 * 1024 * 1024 };

interface ProgressThread {
  owner: ThreadProgressOwner<AcceptedExecutionWriteIntent, ExecutionAcceptedReceipt>;
  head?: AcceptedExecutionState;
  state: AgentModelState;
  durableState: AgentModelState;
  revision: CanonicalAgentRevision;
  publicationSequence: number;
  readonly statuses: Map<string, TurnSavingStatus>;
  epoch: string;
  commandPending: boolean;
  messageSequence: number;
  readonly waiters: Set<{ resolve(): void; reject(error: Error): void }>;
  readonly answeredPlanMessages: Set<string>;
  collaboration?: AcceptedCodexCollaboration;
  features: ReturnType<CanonicalAgentBoundary["loadAcceptedFeatureSeed"]> & { compacting: boolean };
}

/** One bounded live owner retains accepted progress after its execution worker releases. */
export class CanonicalAcceptedProgress {
  readonly epoch = NodeCrypto.randomUUID();
  private readonly threads = new Map<string, ProgressThread>();
  private readonly budget = new BoundedProgressRetention({ maxEvents: 98_304, maxBytes: 96 * 1024 * 1024,
    reservedControlEvents: MAX_OWNERS * LOCAL_LIMITS.reservedControlEvents,
    reservedControlBytes: MAX_OWNERS * LOCAL_LIMITS.reservedControlBytes });
  private readonly saves: AcceptedSaveScheduler<AcceptedExecutionWriteIntent>;
  private onPermanentFailure: ((execution: ExecutionIdentity, error: Error) => Promise<void>) | undefined;
  private pendingSaved: readonly CanonicalAcceptedWriteReceipt[] = [];
  private closing = false;
  private readonly deletingThreads = new Set<string>();

  constructor(private readonly canonical: CanonicalAgentBoundary, private readonly writer: CanonicalAgentWriterClient) {
    this.saves = new AcceptedSaveScheduler({ writer: { append: (batch) => this.save(batch) },
      maxAttempts: 6, retryDelayMs: 1_000, retryable: isTransientSaveFailure,
      onSaved: async (batch, receipt) => this.saved(batch, receipt),
      onFailure: async (batch, failure) => this.failed(batch, failure),
      onObserverError: (batch, error) => { void this.failed(batch, { operationId: batch.operationId, error, exhausted: true }, "receipt")
        .catch((failure: unknown) => logger.error("Accepted progress failure handling failed", { error: failure })); },
    });
  }

  /** Reserve owner capacity and fence new admission before a durable turn command mutates SQLite. */
  async beforeDurableCommand(threadId: string): Promise<void> {
    this.assertOpen();
    const thread = this.thread(threadId);
    if (thread.commandPending) throw new Error("A durable thread command is already pending");
    thread.commandPending = true;
    const saving = thread.owner.savingState();
    if (saving.kind === "failed") { thread.commandPending = false; throw saving.error; }
    if (thread.owner.recoveryCut().retained.length === 0) return;
    await new Promise<void>((resolve, reject) => thread.waiters.add({ resolve, reject }));
  }

  /** Release the admission fence if the durable command fails or conflicts. */
  cancelDurableCommand(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.commandPending = false;
  }

  /** Durable starts form a barrier and seed a new thread stream generation. */
  observeCommitted(events: readonly CanonicalAgentEventEnvelope[], operation?: ExecutionSemanticOperation): void {
    this.assertOpen();
    const threadId = events[0]?.routing.threadId;
    if (!threadId) return;
    const thread = this.thread(threadId);
    if (thread.owner.recoveryCut().retained.length > 0) throw new Error("A durable command overtook accepted progress");
    const recovery = this.canonical.recoverThread(threadId, {
      conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
    if (recovery.mode !== "snapshot") throw new Error("Durable command seed requires a snapshot");
    thread.state = recovery.snapshot.state;
    thread.durableState = thread.state;
    thread.revision = recovery.snapshot.revision;
    thread.epoch = `${this.epoch}:${NodeCrypto.randomUUID()}`;
    thread.owner = this.makeOwner(threadId, thread.epoch, thread.state, thread.revision);
    thread.commandPending = false;
    thread.answeredPlanMessages.clear();
    thread.messageSequence = nextMessageSequence(thread.state);
    thread.features = { ...this.canonical.loadAcceptedFeatureSeed(threadId), compacting: false };
    thread.publicationSequence = thread.features.publicationSequence;
    thread.collaboration = undefined;
    if (operation?.mutation.kind === "begin") thread.head = seedAcceptedExecution(operation, thread.state);
    broadcast("agent.canonical", { phase: "saved", threadId, epoch: thread.epoch,
      through: thread.owner.recoveryCut().saved.sequence, revision: thread.revision, events: [...events] });
    notifyCommittedCanonicalEvents(events);
  }

  /** Reserve the complete prepared operation before releasing its live frames. */
  async acceptWhenReady(operation: ExecutionSemanticOperation): Promise<ExecutionAcceptedReceipt> {
    for (;;) {
      try {
        return this.accept(operation);
      } catch (error) {
        if (!this.shouldWaitForCapacity(error, operation.execution.threadId)) {
          throw this.observationRejection(operation, error);
        }
        try {
          await this.waitForAcceptedCapacity(operation.execution.threadId, error instanceof Error ? error : new Error(String(error)));
        } catch (failure) {
          throw this.observationRejection(operation, failure);
        }
      }
    }
  }

  private observationRejection(operation: ExecutionSemanticOperation, error: unknown): unknown {
    if (operation.mutation.kind !== "append-events") return error;
    const thread = this.threads.get(operation.execution.threadId);
    const head = thread?.head;
    if (!thread || !head || !sameExecution(head.execution, operation.execution)
      || !sameLease(head.lease, operation.lease) || operation.ordinal !== head.ordinal + 1) return error;
    // A committed/accepted identity must never be reused for different content.
    if (thread.owner.replay(operation.operationId, operationInputHash(operation)).kind !== "unknown") return error;
    return new RejectedProviderObservationError(error);
  }

  /** Reserve the complete prepared operation before releasing its live frames. */
  accept(operation: ExecutionSemanticOperation): ExecutionAcceptedReceipt {
    this.assertOpen();
    const thread = this.thread(operation.execution.threadId);
    this.assertAdmission(thread);
    const replay = this.operationAdmission(thread, operation);
    if (replay.kind === "duplicate") return replay.receipt;
    const { head, inputHash } = replay;
    const collaboration = prepareAcceptedCollaboration(thread.state, operation, thread.collaboration);
    const modelThread = thread.state.threads[operation.execution.threadId];
    const turn = thread.state.turns[operation.execution.turnId];
    if (!modelThread || !turn) throw new Error("Accepted parent execution has no admitted model");
    const acceptedAt = new Date().toISOString();
    const features = prepareAcceptedFeatureObservations({ operation: collaboration.operation, thread: modelThread, turn,
      items: thread.state.items, acceptedAt, messageSequence: thread.messageSequence,
      compaction: { active: thread.features.compacting }, currentNoticeSessionId: thread.features.noticeSessionId,
      persistedPlans: thread.features.plans, persistedTasks: thread.features.tasks,
      childPublicationOwners: acceptedChildPublicationOwners(collaboration) });
    const preparedOperation = { ...collaboration.operation, livePublication: features.publications };
    const publications = features.publications;
    const publicationIds = publications.map((_, index) => String(thread.publicationSequence + index + 1));
    const prepared = prepareAcceptedParentEvents({ operation: preparedOperation, thread: modelThread, turn, items: thread.state.items,
      publicationIds, messageSequence: thread.messageSequence, acceptedAt });
    prependObservationEvents(prepared.events, [...collaboration.events, ...features.events]);
    const nextHead = advanceAcceptedExecution(head, operation, prepared.terminalMessage);
    let candidate = thread.state;
    const admission = thread.owner.accept({ operationId: operation.operationId, execution: operation.execution,
      events: prepared.events, write: { kind: "execution", operation: prepared.storageOperation ?? operation,
        phase: nextHead.phase, nativeCursor: nextHead.nativeCursor, features: featureWriteMetadata(features) },
      admission: isControl(operation) ? "control" : "progress" }, (batch) => {
      if (operation.ordinal !== head.ordinal + 1) return false;
      const reduction = reduceAgentEventBatch(thread.state, acceptedEnvelopes(batch));
      if (reduction.outcome !== "applied") return false;
      candidate = compactReduction(reduction.state);
      return true;
    }, { inputHash, receipt: (batch) => this.acceptedReceipt(operation, batch, prepared) });
    if (admission.kind === "rejected") throw new ProgressAdmissionError(admission.reason);
    if (admission.kind === "duplicate") throw new Error("Accepted operation has no original producer receipt");
    thread.state = candidate;
    this.advanceMessageSequence(thread, prepared.events);
    this.installCollaboration(thread, collaboration.candidate);
    this.installFeatureState(thread, features);
    thread.head = nextHead;
    thread.publicationSequence += publications.length;
    this.publishAccepted(admission.batch);
    this.saves.enqueue(admission.batch);
    this.publishAcceptedFeatures(operation, features);
    const original = thread.owner.replay(operation.operationId, inputHash);
    if (original.kind !== "duplicate") throw new Error("Accepted operation lost its producer receipt");
    return original.receipt;
  }

  private publishAcceptedFeatures(operation: ExecutionSemanticOperation, features: ReturnType<typeof prepareAcceptedFeatureObservations>): void {
    try {
      this.publishSaving(operation.execution.threadId);
      this.publishPlanQuestions(operation);
      if (features.planGenerated) broadcast("plan.generated", features.planGenerated);
    } catch (error) {
      logger.warn("Accepted progress feature publication failed", { threadId: operation.execution.threadId,
        executionId: operation.execution.executionId, errorType: error instanceof Error ? error.name : "unknown" });
    }
  }

  private installCollaboration(thread: ProgressThread, candidate?: AcceptedCodexCollaboration): void {
    if (candidate) thread.collaboration = candidate;
  }

  private installFeatureState(thread: ProgressThread, features: AcceptedFeatureObservations): void {
    if (features.compacting !== undefined) thread.features.compacting = features.compacting;
    if (Object.hasOwn(features, "noticeSessionId")) thread.features.noticeSessionId = features.noticeSessionId;
    for (const plan of features.planRecords ?? []) {
      const index = thread.features.plans.findIndex((record) => record.id === plan.id);
      if (index < 0) thread.features.plans.push(plan);
      else thread.features.plans[index] = plan;
    }
  }

  /** Plan cards and controls read their assigned identities before saving finishes. */
  listPlans(threadId: string): PlanRecord[] | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    if (!thread.head) {
      // Legacy status writes have no canonical event to update this owner after the repository commits.
      const saved = new Map(this.canonical.loadAcceptedFeatureSeed(threadId).plans.map((plan) => [plan.id, plan]));
      thread.features.plans = thread.features.plans.map((plan) =>
        this.planExecution(thread, threadId, plan.id) ? plan : saved.get(plan.id) ?? plan);
    }
    return structuredClone(thread.features.plans);
  }

  /** Task hydration reads the accepted board while its compatibility row is still queued. */
  getTasks(threadId: string): StoredTask[] | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    const item = thread.state.items[`taskBoard:${threadId}`];
    return item?.payload.projection === "taskBoard" && Array.isArray(item.payload.tasks)
      ? item.payload.tasks.map((task) => storedTaskFromAccepted(task)) : structuredClone(thread.features.tasks);
  }

  /** Plan status changes are ordered behind their accepted message and plan identity. */
  updatePlanStatus(planId: string, status: PlanStatus): boolean {
    this.assertOpen();
    for (const [threadId, thread] of this.threads) {
      const index = thread.features.plans.findIndex((plan) => plan.id === planId);
      const existing = thread.features.plans[index];
      if (!existing) continue;
      this.assertAdmission(thread);
      const ownership = this.planExecution(thread, threadId, planId);
      if (!ownership) return false;
      const plan = PlanRecordSchema().parse({ ...existing, status });
      const { execution, phase, nativeCursor } = ownership;
      const operationId = `plan-status:${NodeCrypto.randomUUID()}`;
      const itemId = operationId;
      const now = new Date().toISOString();
      this.acceptAuxiliary(thread, operationId, execution, [{ eventId: `${operationId}:record`,
        routing: { ...execution, itemId }, sourceProviderId: thread.state.threads[threadId]?.providerId ?? "server", sourceIdentities: [],
        payload: { type: "item.recorded", item: { id: itemId, threadId, turnId: execution.turnId, kind: "system",
          providerIdentities: [], payload: { projection: "plan", plan }, createdAt: now, updatedAt: now } },
      }], phase, nativeCursor, { planRecords: [plan] });
      thread.features.plans[index] = plan;
      return true;
    }
    return false;
  }

  private planExecution(thread: ProgressThread, threadId: string, planId: string) {
    if (thread.head) return auxiliaryExecution(thread, threadId);
    const turn = this.savedPlanTurn(threadId, planId);
    if (!turn?.executionId || turn.threadId !== threadId) return undefined;
    const checkpoint = this.canonical.loadCheckpoint(turn.executionId);
    return { execution: { threadId, turnId: turn.id, executionId: turn.executionId },
      phase: checkpoint?.phase ?? "finalized", nativeCursor: checkpoint?.nativeCursor ?? null };
  }

  private savedPlanTurn(threadId: string, planId: string) {
    const item = this.canonical.loadItem(`plan:${planId}`);
    if (item?.threadId !== threadId || item.payload.projection !== "plan") return undefined;
    const plan = PlanRecordSchema().safeParse(item.payload.plan);
    if (!plan.success || plan.data.id !== planId) return undefined;
    return this.canonical.loadTurn(item.turnId);
  }

  private advanceMessageSequence(thread: ProgressThread, events: readonly import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[]): void {
    for (const event of events) {
      if (event.payload.type !== "item.recorded" || event.payload.item.payload.projection !== "message") continue;
      const message = event.payload.item.payload.message;
      if (typeof message === "object" && message !== null && "sequence" in message && typeof message.sequence === "number") {
        thread.messageSequence = Math.max(thread.messageSequence, message.sequence + 1);
      }
    }
  }

  private operationAdmission(thread: ProgressThread, operation: ExecutionSemanticOperation):
    { readonly kind: "duplicate"; readonly receipt: ExecutionAcceptedReceipt }
    | { readonly kind: "new"; readonly head: AcceptedExecutionState; readonly inputHash: string } {
    const head = requireExecutionHead(thread, operation);
    const inputHash = operationInputHash(operation);
    const replay = thread.owner.replay(operation.operationId, inputHash);
    if (replay.kind === "duplicate") return replay;
    if (replay.kind === "conflict") throw new ProgressAdmissionError("identity-conflict");
    if (operation.ordinal !== head.ordinal + 1) throw new ProgressAdmissionError("routing-conflict");
    return { kind: "new", head, inputHash };
  }

  private acceptedReceipt(operation: ExecutionSemanticOperation, batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>,
    prepared: ReturnType<typeof prepareAcceptedParentEvents>): ExecutionAcceptedReceipt {
    return { kind: "accepted", operationId: operation.operationId, progressPosition: batch.through,
      acceptedThrough: batch.events.at(-1)?.acceptedSequence ?? 0,
      eventCount: operation.mutation.kind === "append-events" ? operation.mutation.events.length : 0,
      ...(prepared.terminalMessage && operation.mutation.kind === "finish-live-event" ? { terminalAcceptance: {
        messageId: prepared.terminalMessage.id, outcome: operation.mutation.outcome,
        toolCallCount: operation.mutation.projection.narrative.filter((item) => item.kind === "toolCall").length,
        filesChanged: [...operation.mutation.input.fileEvidence?.filesChanged ?? []],
      } } : {}),
    };
  }

  /** Resolve plan and late-effect identities from accepted state before storage catches up. */
  latestAssistantMessage(threadId: string): Message | undefined {
    const message = this.threads.get(threadId)?.head?.assistant;
    return message?.content ? structuredClone(message) : undefined;
  }

  /** Roster reads use accepted child identities while the family save stream is pending. */
  loadSubagentRoster(request: CanonicalSubagentRosterRequest) {
    const thread = this.threads.get(request.owningParentThreadId);
    return thread ? this.canonical.projectAcceptedSubagentRoster(request, thread.state) : undefined;
  }

  /** Resolve the exact child native turn from this parent's accepted family. */
  loadSubagentStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null | undefined {
    const thread = this.threads.get(request.owningParentThreadId);
    if (!thread) return undefined;
    const child = thread.state.threads[request.childThreadId];
    if (!child || !inAcceptedFamily(thread.state, child.id, request.owningParentThreadId)) return null;
    const turn = Object.values(thread.state.turns).filter((candidate) => candidate.threadId === child.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0] ?? null;
    return { childThread: child, latestTurn: turn,
      nativeThreadId: nativeIdentityValue(child.providerIdentities, child.providerId, "thread"),
      nativeTurnId: nativeIdentityValue(turn?.providerIdentities ?? [], child.providerId, "turn") };
  }

  /** Parent Stop addresses retained children before their first saved row exists. */
  loadActiveSubagentStopTargets(parentId: string): SubagentStopTarget[] | undefined {
    const thread = this.threads.get(parentId);
    if (!thread) return undefined;
    return Object.keys(thread.state.threads).flatMap((childThreadId) => {
      if (childThreadId === parentId) return [];
      const target = this.loadSubagentStopTarget({ owningParentThreadId: parentId, childThreadId });
      return target?.latestTurn?.status === "Running" ? [target] : [];
    });
  }

  /** Child Stop is an owner control observation and does not consume a worker command ordinal. */
  finishSubagentTurn(input: { childThreadId: string; nativeTurnId: string; outcome: "interrupted"; error: string }) {
    return this.interruptAcceptedChild(input.childThreadId, input.error, input.nativeTurnId);
  }

  /** Return false only when these children have no retained owner and need the saved-state path. */
  interruptSubagentTurns(childThreadIds: readonly string[], reason: string): boolean {
    if (childThreadIds.some((id) => !this.threads.has(this.ownerThreadId(id)))) return false;
    for (const id of childThreadIds) this.interruptAcceptedChild(id, reason);
    return true;
  }

  private interruptAcceptedChild(childId: string, error: string, nativeTurnId?: string) {
    this.assertOpen();
    const ownerId = this.ownerThreadId(childId);
    const thread = this.threads.get(ownerId);
    if (!thread || childId === ownerId) return undefined;
    this.assertAdmission(thread);
    const head = thread.head;
    if (!head) throw new Error("Accepted child Stop has no parent execution owner");
    const candidate = thread.collaboration?.fork(thread.state) ?? new AcceptedCodexCollaboration(thread.state);
    const prepared = candidate.prepareChildInterruption({ childThreadId: childId, error,
      ...(nativeTurnId ? { nativeTurnId } : {}) });
    if (!prepared.turn) throw new Error("Accepted child Stop no longer matches the selected native turn");
    if (prepared.changes.length === 0) return prepared.turn;
    const operationId = `child-stop:${prepared.turn.executionId}`;
    const changes = prepared.changes.map((change) => observedControlChange(change));
    this.acceptControl(thread, operationId, [{ eventId: `${operationId}:collaboration`, routing: head.execution,
      sourceProviderId: head.providerId, sourceIdentities: [], payload: { type: "collaboration.observed", changes } }]);
    thread.collaboration = candidate;
    return prepared.turn;
  }

  private acceptControl(thread: ProgressThread, operationId: string,
    events: readonly import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[]): void {
    const head = thread.head;
    if (!head) throw new Error("Accepted control has no parent execution owner");
    this.acceptAuxiliary(thread, operationId, head.execution, events, head.phase, head.nativeCursor);
  }

  private acceptAuxiliary(thread: ProgressThread, operationId: string, execution: ExecutionIdentity,
    events: readonly import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[], phase: string,
    nativeCursor: unknown | null = null, features?: AcceptedFeatureWriteMetadata): readonly AcceptedCanonicalAgentEventEnvelope[] {
    this.assertOpen();
    this.assertAdmission(thread);
    let candidate = thread.state;
    const admission = thread.owner.accept({ operationId, execution, admission: "control", events,
      write: { kind: "control", phase, nativeCursor, features } }, (batch) => {
      const reduction = reduceAgentEventBatch(thread.state, acceptedEnvelopes(batch));
      if (reduction.outcome !== "applied") return false;
      candidate = compactReduction(reduction.state);
      return true;
    });
    if (admission.kind === "rejected") throw new ProgressAdmissionError(admission.reason);
    if (admission.kind === "duplicate") return [];
    thread.state = candidate;
    this.publishAccepted(admission.batch);
    this.saves.enqueue(admission.batch);
    this.advanceMessageSequence(thread, events);
    this.publishSaving(execution.threadId);
    return acceptedEnvelopes(admission.batch);
  }

  /** Publish session diagnostics before saving while retaining their genuine source ownership. */
  acceptThreadSystemObservation(input: Extract<AgentEvent, { type: "system" }>): Extract<AgentEvent, { type: "system" }> {
    this.assertOpen();
    const event = AgentEventSchema().parse(input);
    if (event.type !== "system") throw new Error("Thread system admission requires a system event");
    const thread = this.thread(event.threadId);
    const { turn, execution, phase, nativeCursor } = this.threadSystemExecution(thread, event);
    const modelThread = thread.state.threads[event.threadId] ?? this.canonical.loadThreadForAcceptance(event.threadId);
    if (!modelThread) throw new Error("Thread system admission requires an existing canonical conversation");
    const operationId = `thread-system:${NodeCrypto.randomUUID()}`;
    const features = prepareAcceptedThreadSystemFeatures({ operation: { operationId, execution },
      thread: modelThread, turn, items: thread.state.items, acceptedAt: new Date().toISOString(),
      messageSequence: thread.messageSequence, compaction: { active: thread.features.compacting },
      currentNoticeSessionId: thread.features.noticeSessionId, event });
    const published = features.publications[0]?.event;
    if (published?.type !== "system") throw new Error("Thread system preparation lost its publication");
    const publicationId = String(thread.publicationSequence + 1);
    const drafts = [...features.events, { eventId: `${operationId}:publication`, routing: execution,
      sourceProviderId: modelThread.providerId, sourceIdentities: [],
      payload: { type: "publication.recorded" as const, publicationId, event: { ...published, publicationId } } }];
    this.acceptAuxiliary(thread, operationId, execution, drafts, phase, nativeCursor, featureWriteMetadata(features));
    this.installFeatureState(thread, features);
    thread.publicationSequence += 1;
    return { ...published, publicationId };
  }

  private threadSystemExecution(thread: ProgressThread, event: Extract<AgentEvent, { type: "system" }>) {
    const head = thread.head;
    if (head && (event.turnExecutionId === undefined || event.turnExecutionId === head.execution.executionId)) {
      const turn = thread.state.turns[head.execution.turnId];
      if (!turn) throw new Error("Thread system admission lost its retained canonical turn");
      return { turn, execution: head.execution, phase: head.phase, nativeCursor: head.nativeCursor };
    }
    const { turn, execution } = this.savedThreadSystemExecution(event);
    const checkpoint = this.canonical.loadCheckpoint(execution.executionId);
    return { turn, execution, phase: checkpoint?.phase ?? "finalized", nativeCursor: checkpoint?.nativeCursor ?? null };
  }

  private savedThreadSystemExecution(event: Extract<AgentEvent, { type: "system" }>) {
    const turn = event.turnExecutionId ? this.canonical.loadTurnByExecution(event.turnExecutionId)
      : this.canonical.loadLatestTurn(event.threadId);
    if (!turn?.executionId || turn.threadId !== event.threadId) {
      throw new Error("Thread system admission requires an existing canonical turn belonging to its thread");
    }
    return { turn, execution: { threadId: turn.threadId, turnId: turn.id, executionId: turn.executionId } };
  }

  /** Server lifecycle publications enter the same stream behind any unsaved provider suffix. */
  acceptSynthesizedPublications(threadId: string, input: readonly Record<string, unknown>[]): readonly AcceptedCanonicalAgentEventEnvelope[] {
    this.assertOpen();
    if (input.length === 0 || input.length > 64) throw new Error("Synthesized publication batch exceeds its bound");
    const events = input.map((event) => AgentEventSchema().parse(event));
    if (events.some((event) => event.threadId !== threadId)) throw new Error("Synthesized publication belongs to another thread");
    const thread = this.thread(threadId);
    this.assertAdmission(thread);
    const modelThread = thread.state.threads[threadId] ?? this.canonical.loadThreadForAcceptance(threadId);
    if (!modelThread) throw new Error("Synthesized publication has no existing conversation");
    const { execution, phase, nativeCursor } = auxiliaryExecution(thread, threadId);
    const routing = execution.turnId ? execution
      : { threadId: execution.threadId, executionId: execution.executionId };
    const operationId = `synthesized:${NodeCrypto.randomUUID()}`;
    const drafts: import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[] = [];
    if (!thread.state.threads[threadId]) drafts.push({ eventId: `${operationId}:thread`, routing,
      sourceProviderId: modelThread.providerId, sourceIdentities: [], payload: { type: "thread.recorded", thread: modelThread } });
    for (const [index, event] of events.entries()) {
      const publicationId = String(thread.publicationSequence + index + 1);
      drafts.push({ eventId: `${operationId}:publication:${index}`, routing, sourceProviderId: modelThread.providerId,
        sourceIdentities: [], payload: { type: "publication.recorded", publicationId, event: { ...event, publicationId } } });
    }
    const accepted = this.acceptAuxiliary(thread, operationId, execution, drafts, phase, nativeCursor);
    thread.publicationSequence += events.length;
    return accepted;
  }

  /** Admit one answered marker behind its exact accepted assistant content. */
  markPlanAnswered(threadId: string, messageId: string): boolean {
    this.assertOpen();
    const thread = this.threads.get(threadId);
    if (thread) this.assertAdmission(thread);
    const head = thread?.head;
    if (!thread || !head || head.assistant.id !== messageId) return false;
    if (thread.answeredPlanMessages.has(messageId)) return true;
    const operationId = `plan-answer:${NodeCrypto.randomUUID()}`;
    const acceptedAt = new Date().toISOString();
    const itemId = `message:${messageId}`;
    let candidate = thread.state;
    const admission = thread.owner.accept({ operationId, execution: head.execution, admission: "control",
      write: { kind: "plan-answer", assistant: head.assistant, phase: head.phase, nativeCursor: head.nativeCursor },
      events: [{ eventId: `${operationId}:message`, routing: { ...head.execution, itemId }, sourceProviderId: head.providerId,
        sourceIdentities: [], payload: { type: "item.recorded", item: { id: itemId, threadId, turnId: head.execution.turnId,
          kind: "message", providerIdentities: [], payload: { projection: "message",
            message: { ...head.assistant, is_internal: head.phase !== "finalized" } },
          createdAt: head.assistant.timestamp, updatedAt: acceptedAt } } },
      { eventId: `${operationId}:marker`, routing: head.execution, sourceProviderId: head.providerId,
        sourceIdentities: [], payload: { type: "execution.checkpoint", operationKind: "plan-answer" } }],
    }, (batch) => {
      const reduction = reduceAgentEventBatch(thread.state, acceptedEnvelopes(batch));
      if (reduction.outcome !== "applied") return false;
      candidate = compactReduction(reduction.state);
      return true;
    });
    if (admission.kind !== "accepted") throw new Error("Accepted plan marker could not reserve its control capacity");
    thread.state = candidate;
    thread.answeredPlanMessages.add(messageId);
    this.publishAccepted(admission.batch);
    this.saves.enqueue(admission.batch);
    this.publishSaving(threadId);
    return true;
  }

  /** Bind exact active-execution shutdown when saved receipts or their capacity cannot be trusted. */
  bindPermanentFailure(callback: (execution: ExecutionIdentity, error: Error) => Promise<void>): void {
    this.onPermanentFailure = callback;
  }

  /** A lost worker's terminal observation enters the same owner without awaiting unavailable storage. */
  interruptWorkerLoss(input: LostExecutionInterruption) {
    const operationId = `${input.lease.leaseId}:worker-lost`;
    const thread = this.threads.get(input.execution.threadId);
    const head = thread?.head;
    if (!thread || !head) return { kind: "conflict" as const, operationId, recoveryState: "not-started" as const };
    if (!sameExecution(head.execution, input.execution) || !sameLease(head.lease, input.lease)) {
      return { kind: "conflict" as const, operationId };
    }
    if (thread.state.turns[input.execution.turnId]?.status !== "Running") {
      return { kind: "conflict" as const, operationId, recoveryState: "already-terminal" as const };
    }
    const operation: ExecutionSemanticOperation = { operationId, execution: input.execution, lease: input.lease,
      ordinal: head.ordinal + 1, livePublication: [{ after: "terminal", event: { type: "ended",
        threadId: input.execution.threadId, turnExecutionId: input.execution.executionId, outcome: "interrupted" } }],
      mutation: { kind: "finish-live-event", outcome: "interrupted", projection: { ...input.execution, outcome: "interrupted",
        endedAt: new Date().toISOString(), assistant: { content: head.assistant.content, model: head.assistant.model ?? null,
          attachments: head.assistant.attachments ?? [], messageId: head.assistant.id }, narrative: acceptedNarrative(thread.state, input.execution) },
        input: { ...input.execution, providerId: head.providerId, providerIdentities: [], outcome: "interrupted",
          projection: { kind: "writer-staged", messageId: head.assistant.id } } } };
    return this.accept(operation);
  }

  private shouldWaitForCapacity(error: unknown, threadId: string): boolean {
    if (!(error instanceof ProgressAdmissionError) || error.admissionReason !== "retention-exhausted") return false;
    const thread = this.threads.get(threadId);
    return thread !== undefined && thread.owner.recoveryCut().retained.length > 0;
  }

  private async waitForAcceptedCapacity(threadId: string, cause: Error): Promise<void> {
    const thread = this.saveThread(threadId);
    const state = thread.owner.savingState();
    if (state.kind === "failed") throw state.error;
    if (thread.owner.recoveryCut().retained.length === 0) throw cause;
    await new Promise<void>((resolve, reject) => thread.waiters.add({ resolve, reject }));
  }

  private publishPlanQuestions(operation: ExecutionSemanticOperation): void {
    const mutation = operation.mutation;
    const effects = mutation.kind === "live-event" ? mutation : mutation.kind === "append-events" ? mutation.parentLive : undefined;
    if (effects?.planQuestions) broadcast("plan.questions", { threadId: operation.execution.threadId, questions: [...effects.planQuestions] });
  }

  /** Read the acknowledged base and retained suffix without touching a stalled writer. */
  recover(threadId: string, _known: CanonicalAgentRevision,
    cursor?: AgentProgressPosition & { readonly ownerThreadId?: string }): CanonicalAgentProgressRecovery {
    const ownerId = this.ownerThreadId(threadId, cursor?.ownerThreadId);
    const thread = this.threads.get(ownerId);
    if (!thread) {
      const saved = this.recoverSaved(ownerId, cursor);
      return ownerId === threadId ? saved : { ...saved, threadId, ownerThreadId: ownerId };
    }
    const cut = thread.owner.recoveryCut();
    return { phase: "recovery", threadId, ...(ownerId !== threadId ? { ownerThreadId: ownerId } : {}), epoch: thread.epoch, acceptedThrough: cut.accepted.sequence,
      savedThrough: cut.saved.sequence, durable: { mode: "snapshot", threadId: ownerId,
        snapshot: { revision: thread.revision, state: thread.durableState } },
      retained: cut.retained.flatMap(acceptedEnvelopes),
      loss: this.lostProgress(ownerId, cursor) ? "runtime-restarted" : "none" };
  }

  /** Retained saving state includes completed executions until their own acknowledgements arrive. */
  savingStatuses(threadId: string): readonly TurnSavingStatus[] {
    return [...this.threads.get(this.ownerThreadId(threadId))?.statuses.values() ?? []].map((status) => ({ ...status, threadId }));
  }

  /** Explicit retries keep the exact immutable operation and accepted event identities. */
  retry(threadId: string): boolean {
    this.assertOpen();
    threadId = this.ownerThreadId(threadId);
    if (!this.saves.retry(threadId)) return false;
    const thread = this.threads.get(threadId);
    const state = thread?.owner.savingState();
    if (thread && state?.kind === "failed") {
      thread.owner.recordFailure({ operationId: state.operationId, error: state.error, exhausted: false });
      this.publishSaving(threadId);
    }
    return true;
  }

  /** Queue depth is content-free and includes failed and in-flight work. */
  depth() { return { ...this.saves.depth(), retained: this.budget.depth() }; }

  /** Native child detail views support Stop while managed conversations retain ordinary deletion. */
  assertThreadDeletionSupported(threadId: string): void {
    if (this.ownerThreadId(threadId) !== threadId) {
      throw new Error("Provider-owned child conversations support Stop; delete their owning conversation instead");
    }
  }

  /** Correlate a late hook with its original accepted terminal, even after another turn starts. */
  acceptLateHook(threadId: string, executionId: string, hook: Omit<CreateHookExecutionInput, "messageId">): void {
    this.assertOpen();
    if (!hook.id) throw new Error("Late hook requires its original stable identity");
    const thread = this.thread(threadId);
    this.assertAdmission(thread);
    const turn = Object.values(thread.state.turns).find((value) => value.threadId === threadId && value.executionId === executionId);
    if (!turn || turn.status === "Running" || turn.status === "Pending") throw new Error("Late hook requires its exact accepted terminal turn");
    const message = exactTerminalAssistant(thread.state, { threadId, turnId: turn.id, executionId });
    const record = HookExecutionRecordSchema().parse({ id: hook.id, message_id: message.id, hook_name: hook.hookName,
      tool_name: hook.toolName, phase: hook.phase, payload: hook.payload, duration_ms: hook.durationMs,
      did_block: hook.didBlock, started_at: hook.startedAt, ended_at: hook.endedAt, sort_order: hook.sortOrder });
    const itemId = `hook:${record.id}`;
    const existing = thread.state.items[itemId];
    if (existing) {
      if (!NodeUtil.isDeepStrictEqual(existing.payload.narrative, { kind: "hook", record })) throw new Error("Late hook identity conflicts with accepted content");
      return;
    }
    const execution = { threadId, turnId: turn.id, executionId };
    const operationId = `late-hook:${record.id}`;
    const providerId = thread.state.threads[threadId]?.providerId ?? "server";
    const publicationId = String(thread.publicationSequence + 1);
    const events: import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[] = [{
      eventId: `${operationId}:record`, routing: { ...execution, itemId }, sourceProviderId: providerId, sourceIdentities: [],
      payload: { type: "item.recorded", item: { id: itemId, threadId, turnId: turn.id, kind: "system", providerIdentities: [],
        payload: { projection: "narrativeRecovery", narrative: { kind: "hook", record } },
        createdAt: record.started_at, updatedAt: record.started_at } },
    }, { eventId: `${operationId}:publication`, routing: execution, sourceProviderId: providerId, sourceIdentities: [],
      payload: { type: "publication.recorded", publicationId, event: { type: "hookCompleted", threadId,
        turnExecutionId: executionId, hookName: hook.hookName, exitCode: 0, durationMs: hook.durationMs ?? 0,
        didBlock: hook.didBlock, persistedMessageId: message.id, persistedHookId: record.id, publicationId } } }];
    this.acceptAuxiliary(thread, operationId, execution, events, "post-terminal");
    thread.publicationSequence += 1;
  }

  /** Delete only after the exact family's in-flight save settles; its unsaved tail is deliberately discarded. */
  async discardThread(threadId: string): Promise<void> {
    this.assertOpen();
    const ownerId = this.ownerThreadId(threadId);
    if (ownerId !== threadId) throw new Error("Delete the owning conversation before discarding its family progress");
    this.deletingThreads.add(threadId);
    const thread = this.threads.get(ownerId);
    if (!thread) return;
    thread.commandPending = true;
    for (const waiter of thread.waiters) waiter.reject(new Error("Accepted conversation was deleted"));
    thread.waiters.clear();
    await this.saves.discardThread(ownerId);
    thread.owner.discard();
    this.threads.delete(ownerId);
  }

  /** Dispose owner queues for a workspace cascade only when every targeted alias's owner is included. */
  async discardThreads(threadIds: readonly string[]): Promise<void> {
    this.assertOpen();
    const targets = new Set(threadIds);
    const owners = new Set(threadIds.map((id) => this.ownerThreadId(id)));
    for (const owner of owners) {
      if (!targets.has(owner)) throw new Error("Conversation deletion must include its native child's owning conversation");
    }
    for (const id of targets) this.deletingThreads.add(id);
    for (const owner of owners) await this.discardThread(owner);
  }

  /** Release the temporary admission fence after the caller's durable deletion attempt finishes. */
  finishThreadDeletion(threadId: string): void { this.deletingThreads.delete(threadId); }

  /** Stop admission before waiting for the single active storage write. */
  close(): Promise<void> {
    this.closing = true;
    const error = new Error("Accepted progress is closing before the durable command completed");
    for (const thread of this.threads.values()) {
      thread.commandPending = false;
      for (const waiter of thread.waiters) waiter.reject(error);
      thread.waiters.clear();
    }
    return this.saves.close();
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Accepted progress is closed");
  }

  private assertAdmission(thread: ProgressThread): void {
    if (thread.commandPending) throw new Error("Accepted progress is fenced by a durable thread command");
  }

  private saveThread(threadId: string): ProgressThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Accepted save requires its retained owner");
    return thread;
  }

  private thread(threadId: string): ProgressThread {
    if (this.deletingThreads.has(threadId)) throw new Error("Accepted conversation deletion is in progress");
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    this.evictSavedThread();
    if (this.threads.size >= MAX_OWNERS) throw new Error("Live progress owner capacity is full");
    const recovery = this.canonical.recoverThread(threadId, {
      conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
    if (recovery.mode !== "snapshot") throw new Error("Canonical progress seed requires a snapshot");
    const { state, revision } = recovery.snapshot;
    const head = this.canonical.savedProgressPosition(threadId);
    const epoch = head?.epoch.startsWith(`${this.epoch}:`) ? head.epoch : `${this.epoch}:${NodeCrypto.randomUUID()}`;
    const features = { ...this.canonical.loadAcceptedFeatureSeed(threadId), compacting: false };
    const thread: ProgressThread = { owner: this.makeOwner(threadId, epoch, state, revision, head?.epoch === epoch ? head : undefined),
      state, durableState: state, revision, publicationSequence: features.publicationSequence, statuses: new Map(), epoch, features,
      commandPending: false, messageSequence: nextMessageSequence(state), waiters: new Set(), answeredPlanMessages: new Set() };
    this.threads.set(threadId, thread);
    return thread;
  }

  private evictSavedThread(): void {
    if (this.threads.size < MAX_OWNERS) return;
    for (const [id, thread] of this.threads) {
      if (!thread.commandPending && thread.owner.recoveryCut().retained.length === 0
        && !Object.values(thread.state.turns).some((turn) => turn.status === "Running" || turn.status === "Pending")) {
        this.threads.delete(id); return;
      }
    }
  }

  private makeOwner(threadId: string, epoch: string, state: AgentModelState, revision: CanonicalAgentRevision,
    savedPosition?: AgentProgressPosition): ThreadProgressOwner<AcceptedExecutionWriteIntent, ExecutionAcceptedReceipt> {
    return new ThreadProgressOwner<AcceptedExecutionWriteIntent, ExecutionAcceptedReceipt>({ threadId, epoch, durableRevision: revision.conversationRevision,
      limits: LOCAL_LIMITS, sharedBudget: this.budget,
      acceptedSequenceByExecution: new Map(Object.entries(state.lastAcceptedSequenceByExecution)), savedPosition });
  }

  private recoverSaved(threadId: string, cursor?: AgentProgressPosition): CanonicalAgentProgressRecovery {
    const durable = this.canonical.recoverThread(threadId, {
      conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
    const head = this.canonical.savedProgressPosition(threadId);
    const sameRuntime = head?.epoch.startsWith(`${this.epoch}:`);
    const epoch = sameRuntime && head ? head.epoch : `${this.epoch}:saved:${threadId}`;
    const through = sameRuntime && head ? head.sequence : 0;
    return { phase: "recovery", threadId, epoch, acceptedThrough: through, savedThrough: through,
      durable, retained: [], loss: this.lostProgress(threadId, cursor) ? "runtime-restarted" : "none" };
  }

  private lostProgress(threadId: string, cursor?: AgentProgressPosition): boolean {
    if (!cursor || cursor.epoch.startsWith(`${this.epoch}:`) || cursor.sequence === 0) return false;
    return this.canonical.savedProgressThrough(threadId, cursor.epoch) < cursor.sequence;
  }

  private publishAccepted(batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>): void {
    const events = acceptedEnvelopes(batch);
    for (let offset = 0; offset < events.length; offset += 256) {
      const page = events.slice(offset, offset + 256);
      try {
        this.publishFamily({ phase: "accepted", threadId: batch.execution.threadId, epoch: batch.through.epoch,
          from: batch.predecessor.sequence + offset, through: batch.predecessor.sequence + offset + page.length, events: page });
      } catch (error) {
        logger.warn("Accepted progress publication failed", { threadId: batch.execution.threadId,
          executionId: batch.execution.executionId, errorType: error instanceof Error ? error.name : "unknown" });
      }
    }
  }

  private async save(batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>): Promise<SavedProgressReceipt> {
    const events = acceptedEnvelopes(batch);
    const thread = this.saveThread(batch.execution.threadId);
    let last: CanonicalAcceptedWriteReceipt | undefined;
    const receipts: CanonicalAcceptedWriteReceipt[] = [];
    for (let offset = 0; offset < events.length; offset += 256) {
      const page = events.slice(offset, offset + 256);
      const final = offset + page.length === events.length;
      last = await this.writer.appendAccepted(events.length <= 256 ? batch.operationId : `${batch.operationId}:page:${offset / 256}`,
        { execution: batch.execution, phase: final ? batch.write.phase : "running",
          nativeCursor: batch.write.nativeCursor, contentHash: batch.contentHash,
          predecessor: { epoch: batch.through.epoch, sequence: batch.predecessor.sequence + offset },
          through: { epoch: batch.through.epoch, sequence: batch.predecessor.sequence + offset + page.length },
          baseRevision: thread.revision.conversationRevision, events: page,
          ...compatibilityFields(batch.write, final),
        });
      receipts.push(last);
    }
    if (!last) throw new Error("Accepted progress has no storage page");
    this.pendingSaved = receipts;
    return { ...last.receipt, operationId: batch.operationId, predecessor: batch.predecessor, through: batch.through };
  }

  private async saved(batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>, receipt: SavedProgressReceipt): Promise<void> {
    const thread = this.saveThread(batch.execution.threadId);
    let candidate = thread.durableState;
    for (const saved of this.pendingSaved) {
      const reduced = reduceAgentEventBatch(candidate, saved.events);
      if (reduced.outcome !== "applied") throw new Error("Saved progress cannot reduce its acknowledged prefix");
      candidate = compactReduction(reduced.state);
    }
    if (!thread.owner.acknowledge(receipt)) throw new Error("Saved receipt does not match the accepted owner prefix");
    thread.durableState = candidate;
    for (const saved of this.pendingSaved) {
      thread.revision = saved.revision;
      this.publishFamily({ phase: "saved", threadId: batch.execution.threadId, epoch: thread.epoch,
        through: saved.receipt.through.sequence, revision: saved.revision, events: [...saved.events] });
      notifyCommittedCanonicalEvents(saved.events);
    }
    const completed = this.pendingSaved;
    this.pendingSaved = [];
    this.publishSaving(batch.execution.threadId);
    if (thread.owner.recoveryCut().retained.length === 0) {
      for (const waiter of thread.waiters) waiter.resolve();
      thread.waiters.clear();
    }
    await this.retireSavedReceipts(batch, completed, thread);
  }

  private async retireSavedReceipts(batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>,
    receipts: readonly CanonicalAcceptedWriteReceipt[], thread: ProgressThread): Promise<void> {
    for (const saved of receipts) {
      try {
        await this.writer.acknowledgeOperation(batch.execution.executionId, saved.receipt.operationId);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("Saved receipt cleanup failed", { cause });
        logger.error("Accepted progress saved receipt cleanup failed", { threadId: batch.execution.threadId,
          operationId: saved.receipt.operationId, error: describeSaveFailure(error),
          pendingAcknowledgements: this.writer.pendingAcknowledgementCount });
        if (error instanceof CanonicalWriterAcknowledgementCapacity) {
          try { await this.stopFailedOwner(thread, error); }
          catch (stopError) { logger.error("Accepted progress receipt cleanup could not stop its active owner", {
            threadId: batch.execution.threadId, error: describeSaveFailure(stopError instanceof Error ? stopError : new Error(String(stopError))) }); }
        }
      }
    }
  }

  private async failed(batch: AcceptedProgressBatch<AcceptedExecutionWriteIntent>, failure: ProgressSaveFailure,
    source: "storage" | "receipt" = "storage"): Promise<void> {
    const thread = this.saveThread(batch.execution.threadId);
    thread.owner.recordFailure(failure);
    if (failure.exhausted) {
      thread.commandPending = false;
      for (const waiter of thread.waiters) waiter.reject(failure.error);
      thread.waiters.clear();
    }
    logger.error(source === "receipt" ? "Accepted progress receipt processing failed" : "Accepted progress save failed", { threadId: batch.execution.threadId,
      executionId: batch.execution.executionId, operationId: batch.operationId, error: describeSaveFailure(failure.error),
      exhausted: failure.exhausted, queue: this.depth() });
    this.publishSaving(batch.execution.threadId);
    // Disk failure retains the accepted stream; invalid receipt application still invalidates execution ownership.
    if (failure.exhausted && source === "receipt") await this.stopFailedOwner(thread, failure.error);
  }

  private async stopFailedOwner(thread: ProgressThread, error: Error): Promise<void> {
    const active = thread.head?.execution;
    if (active && thread.state.turns[active.turnId]?.status === "Running") await this.onPermanentFailure?.(active, error);
  }

  private publishSaving(threadId: string): void {
    const thread = this.saveThread(threadId);
    const cut = thread.owner.recoveryCut();
    const executions = new Set([...thread.statuses.keys(), ...cut.retained.map((batch) => batch.execution.executionId)]);
    for (const executionId of executions) {
      const status = this.savingStatus(threadId, executionId, thread);
      thread.statuses.set(executionId, status);
      broadcast("turn.savingStatus", status);
      for (const childId of this.familyTargets(threadId, thread)) broadcast("turn.savingStatus", { ...status, threadId: childId });
      if (status.mode === "durable") thread.statuses.delete(executionId);
    }
  }

  private savingStatus(threadId: string, executionId: string, thread: ProgressThread): TurnSavingStatus {
    const cut = thread.owner.recoveryCut();
    const batches = cut.retained.filter((batch) => batch.execution.executionId === executionId);
    if (batches.length === 0) return { threadId, executionId, mode: "durable" };
    const common = { threadId, executionId, accepted: cut.accepted, saved: cut.saved,
      pendingEvents: batches.reduce((sum, batch) => sum + batch.events.length, 0),
      pendingBytes: batches.reduce((sum, batch) => sum + batch.byteLength, 0),
      oldestPendingAt: batches[0]?.events[0]?.acceptedAt ?? new Date().toISOString() };
    const failure = thread.owner.savingState();
    if (failure.kind !== "failed" && failure.kind !== "delayed") return { ...common, mode: "saving" };
    return { ...common, mode: failure.kind === "failed" ? "saving-failed" : "save-retrying",
      failure: { kind: isTransientSaveFailure(failure.error) ? "transient" : "permanent",
        name: failure.error.name.slice(0, 128), message: failure.error.message.slice(0, 2_000) } };
  }

  private ownerThreadId(threadId: string, hint?: string): string {
    if (this.threads.has(threadId)) return threadId;
    for (const [ownerId, thread] of this.threads) if (inAcceptedFamily(thread.state, threadId, ownerId)) return ownerId;
    return this.savedOwnerThreadId(threadId, hint);
  }

  private savedOwnerThreadId(threadId: string, hint?: string): string {
    const saved = this.canonical.loadThread(threadId);
    const ownerId = saved?.owningParentThreadId ?? saved?.parentThreadId;
    if (ownerId) {
      if (hint && hint !== ownerId) throw new Error("Recovered child owner conflicts with its saved lineage");
      return ownerId;
    }
    if (!saved && hint && this.canonical.loadThread(hint)) return hint;
    return threadId;
  }

  private familyTargets(ownerId: string, thread: ProgressThread): string[] {
    return [...subscribedThreadIds()].filter((id) => id !== ownerId && !this.threads.has(id)
      && inAcceptedFamily(thread.state, id, ownerId));
  }

  private publishFamily(frame: CanonicalAgentProgressFrame): void {
    broadcast("agent.canonical", frame);
    const thread = this.threads.get(frame.threadId);
    if (!thread) return;
    for (const childId of this.familyTargets(frame.threadId, thread)) {
      broadcast("agent.canonical", { ...frame, threadId: childId, ownerThreadId: frame.threadId });
    }
  }
}

function inAcceptedFamily(state: AgentModelState, threadId: string, ownerId: string): boolean {
  const seen = new Set<string>();
  let id: string | undefined = threadId;
  while (id && !seen.has(id)) {
    if (id === ownerId) return state.threads[id] !== undefined;
    seen.add(id);
    id = state.threads[id]?.parentThreadId;
  }
  return false;
}

function acceptedEnvelopes<WriteIntent>(batch: AcceptedProgressBatch<WriteIntent>): AcceptedCanonicalAgentEventEnvelope[] {
  return batch.events.map(({ draft, acceptedSequence, position, acceptedAt }) => {
    const { ingestClass: _ingestClass, ...event } = draft;
    return AcceptedCanonicalAgentEventEnvelopeSchema.parse({ ...event, acceptedSequence,
      progressPosition: position, serverTimestamps: { acceptedAt } });
  });
}

function compactReduction(state: AgentModelState): AgentModelState {
  return { ...state, appliedEventIds: {}, acceptedInputEventIds: {} };
}

function nextMessageSequence(state: AgentModelState): number {
  let sequence = 0;
  for (const item of Object.values(state.items)) {
    const message = item.payload.message;
    if (item.payload.projection === "message" && typeof message === "object" && message !== null
      && "sequence" in message && typeof message.sequence === "number") sequence = Math.max(sequence, message.sequence);
  }
  return sequence + 1;
}

function isTerminal(operation: ExecutionSemanticOperation): operation is ExecutionSemanticOperation & {
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "finish-live-event" }>
} { return operation.mutation.kind === "finish-live-event"; }

function isControl(operation: ExecutionSemanticOperation): boolean {
  return isTerminal(operation) || !["append-events", "live-event", "narrative-delta"].includes(operation.mutation.kind);
}

function compatibilityFields(write: AcceptedExecutionWriteIntent, final: boolean):
  Pick<CanonicalAcceptedWriteInput, "compatibility" | "terminalOutcome" | "planAnswer" | "features"> {
  if (!final) return {};
  if (write.kind === "control") return { features: write.features };
  if (write.kind === "plan-answer") return { planAnswer: write.assistant };
  const operation = write.operation;
  return isTerminal(operation) ? { compatibility: operation, terminalOutcome: operation.mutation.outcome, features: write.features }
    : { compatibility: operation, features: write.features };
}

function featureWriteMetadata(features: AcceptedFeatureObservations): AcceptedFeatureWriteMetadata {
  return { threadPatch: features.threadPatch, planRecords: features.planRecords,
    expiredNoticeMessageIds: features.expiredNoticeMessageIds,
    ...(Object.hasOwn(features, "noticeSessionId") ? { noticeSession: { sessionId: features.noticeSessionId ?? null } } : {}) };
}

const acceptedTaskSchema = z.object({ id: z.string().max(256).optional(), content: z.string().min(1).max(16 * 1024),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]), activeForm: z.string().max(4096).optional(),
  group: z.string().max(128).optional() }).strict();

function storedTaskFromAccepted(value: unknown): StoredTask { return acceptedTaskSchema.parse(value); }

function auxiliaryExecution(thread: ProgressThread, threadId: string):
  { execution: ExecutionIdentity; phase: string; nativeCursor: unknown | null } {
  if (thread.head) return { execution: thread.head.execution, phase: thread.head.phase, nativeCursor: thread.head.nativeCursor };
  return { execution: { threadId, turnId: "", executionId: syntheticThreadExecutionId(threadId) }, phase: "synthesized", nativeCursor: null };
}

function exactTerminalAssistant(state: AgentModelState, execution: ExecutionIdentity): Message {
  for (const item of Object.values(state.items)) {
    if (item.threadId !== execution.threadId || item.turnId !== execution.turnId || item.payload.projection !== "message") continue;
    const parsed = MessageSchema().safeParse(item.payload.message);
    if (parsed.success && parsed.data.role === "assistant" && parsed.data.outcomeExecutionId === execution.executionId) return parsed.data;
  }
  throw new Error("Late hook terminal has no assistant message");
}

function observedControlChange(change: import("./accepted-codex-collaboration.js").AcceptedCollaborationChange): CollaborationObservationChange {
  if (change.kind === "diagnostic") {
    throw new Error("Accepted child Stop prepared an unrelated observation");
  }
  return change;
}

function nativeIdentityValue(identities: readonly import("@mcode/contracts").ProviderIdentity[], providerId: string,
  scope: "thread" | "turn"): string | null {
  return identities.find((identity) => identity.providerId === providerId && identity.scope === scope
    && identity.provenance === "native")?.value ?? null;
}

function acceptedChildPublicationOwners(collaboration: ReturnType<typeof prepareAcceptedCollaboration>): readonly AcceptedChildPublicationOwner[] {
  const candidate = collaboration.candidate;
  if (!candidate) return [];
  return (collaboration.operation.livePublication ?? []).flatMap(({ event }) => {
    const thread = candidate.loadThread(event.threadId);
    const turn = event.turnExecutionId ? candidate.loadTurnByExecution(event.turnExecutionId) : null;
    return thread?.parentThreadId && turn ? [{ thread, turn }] : [];
  });
}

function prependObservationEvents(events: import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[],
  observation: readonly import("./canonical-agent-boundary.js").CanonicalAgentEventDraft[]): void {
  const publicationStart = events.findIndex((event) => event.payload.type === "publication.recorded");
  events.splice(publicationStart < 0 ? events.length : publicationStart, 0, ...observation);
}

function operationInputHash(operation: ExecutionSemanticOperation): string {
  const hash = NodeCrypto.createHash("sha256");
  if (operation.mutation.kind !== "finish-live-event") return hash.update(JSON.stringify(operation)).digest("hex");
  const { narrative, ...projection } = operation.mutation.projection;
  hash.update(JSON.stringify({ ...operation, mutation: { ...operation.mutation, projection } }));
  // Fingerprint the full producer intent without retaining or allocating a second history-sized string.
  hash.update(`:narrative:${narrative.length}:[`);
  for (const item of narrative) hash.update(JSON.stringify(item)).update(",");
  return hash.update("]").digest("hex");
}

function requireExecutionHead(thread: ProgressThread, operation: ExecutionSemanticOperation): AcceptedExecutionState {
  const head = thread.head;
  if (!head || !sameExecution(head.execution, operation.execution) || !sameLease(head.lease, operation.lease)) {
    throw new Error("Accepted progress has no matching execution lease");
  }
  return head;
}

function isTransientSaveFailure(error: Error): boolean {
  if ("code" in error && typeof error.code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(error.code)) return true;
  return error.cause instanceof Error && isTransientSaveFailure(error.cause);
}

function describeSaveFailure(error: Error): { name: string; message: string; code?: string; cause?: ReturnType<typeof describeSaveFailure> } {
  return { name: error.name, message: error.message,
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...(error.cause instanceof Error ? { cause: describeSaveFailure(error.cause) } : {}) };
}
