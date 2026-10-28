/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject, delay } from "tsyringe";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { ProviderRuntimeEventSchema, isChildRoutedRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { isSessionEvictable, isTurnSteerCapable } from "@mcode/contracts/providers/interfaces";
import { providerFailureOutcome } from "@mcode/contracts/models/turn-failure";
import type { ClaudeCanonicalEventRouting, ClaudeProviderBoundary, CodexProviderBoundary, CopilotProviderBoundary, ProviderTurnOpening } from "@mcode/providers";
import { ProviderTurnError } from "@mcode/providers";
import type { Thread } from "@mcode/contracts/models/thread";
import type { IProviderRegistry, IAgentProvider, TurnRequest, ProviderId } from "@mcode/contracts/providers/interfaces";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { TurnRuntimeSnapshot, AgentStopResult } from "@mcode/contracts/models/turn-runtime";
import type { ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import type { TurnFailure } from "@mcode/contracts/models/turn-failure";
import type { TurnStopCause } from "@mcode/contracts/compat/agent-model";
import { TurnFileTracker } from "../turns/turn-file-tracker.js";
import type { WorkspaceEnvironmentAutomaticSetupDispatch } from "../../projects/environment/workspace-environment-service.js";
import { MemoryPressureService, type MemoryPressureSnapshot } from "../../../runtime/memory/memory-pressure-service.js";
import { broadcast } from "../../../application/transport/push.js";
import { publishTurnPersisted } from "../execution/turn-persisted-publication.js";
import { ThreadControlMutationReservationService } from "../../thread-control/index.js";
import { McodeSessionAuthority } from "../../mcode-mcp/index.js";
import { ScopedPreGrantService } from "../permissions/scoped-pre-grant.js";
import { TurnErrorPolicy } from "../turns/turn-error-policy.js";
import { TurnRuntimeRegistry } from "../turns/turn-runtime.js";
import type { TurnOutcome } from "../turns/turn-outcome.js";
import { ProviderEventIngress } from "../../providers/composition/provider-event-ingress.js";
import { ExecutionFileEvidenceCoordinator } from "../execution/execution-file-evidence-coordinator.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "../execution/execution-worker-handler.js";
import { WorkerOwnedTurnRuntime } from "../execution/worker-owned-turn-runtime.js";
import type { WorkerOwnedProviderEventBatch } from "../../providers/composition/provider-host-ports.js";
import { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import { SnapshotRefPins } from "../../projects/diffs/snapshots/snapshot-ref-pins.js";
import type { DataOnlyParentTurnFinishInput } from "../canonical/canonical-parent-turn-write.js";
import { observedProviderRetries, persistTurnFailure, providerFailureTerminal, type ObservedProviderRetries, type TurnEndingCause } from "../canonical/turn-ending.js";
import { TurnEventPipeline, type TurnLifecycleControl } from "../turns/turn-event-pipeline.js";
import { TurnDiffService } from "../turns/turn-diff-service.js";
import { ProviderSwitchService } from "../turns/provider-switch-service.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../turns/turn-feature-effects.js";
import { TURN_RUNTIME_PERSISTENCE, type TurnRuntimePersistence } from "../turns/turn-runtime-persistence.js";
import {
  ThreadCreationCoordinator,
  type CreateAndSendCommand,
  type CreateAndSendOptions,
  type CreatedInitialTurn,
} from "../turns/thread-creation-coordinator.js";
import {
  TurnAdmissionDispatchCoordinator,
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  type CommandEffectReceipt,
  type PreparedTurnDispatch,
  type RuntimeReleaseCause,
  type SendMessageCommand,
  type ThreadControlLeaseDirective,
  type TurnRuntimeAdmissionAuthority,
  type TurnRuntimeLease,
  type WorkspaceEnvironmentQueuedTurnSubmission,
} from "../turns/turn-admission-dispatch-coordinator.js";
import { AgentRuntimeCommandPort } from "./agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "./agent-event-publication-registry.js";
import {
  AgentEventPublicationRuntimePort,
} from "./agent-runtime-internal-ports.js";
import { idleRuntime, isActiveRuntimeExecution, isRunningRuntime, ownsStoppedExecution, stopDispatchState } from "./agent-service-helpers.js";
import type { TurnRuntimeEventControl } from "./turn-runtime-event-control.js";
import { TurnSteerRuntimePort, type SteerableTurn } from "../steering/turn-steer-runtime-port.js";

/**
 * Bounded wait for `provider.stopSession` before the turn is force-finalized.
 * Sits above provider-internal cancel bounds (Devin waits 10s before killing
 * its ACP child) so a settled provider still reports graceful cancellation.
 */
const PROVIDER_STOP_SETTLE_TIMEOUT_MS = 15_000;

type RetryDispatchIdentity = Readonly<{
  mutationReservationToken: string;
  generation: number;
}>;

type PreparedStop = {
  threadId: string;
  sessionId: string;
  providerId?: ProviderId;
  reservationToken?: string;
  dispatchState: AgentStopResult["dispatchState"];
  runtime: TurnRuntimeSnapshot;
  stop: TurnStopCause;
};

type UnsentWorkerTerminal = { outcome: "errored" } | { outcome: "cancelled"; stop: TurnStopCause };

interface WorkerOwnedTurn {
  readonly execution: ExecutionIdentity;
  readonly prepared: PreparedTurnDispatch;
  readonly provider: IAgentProvider;
  deliveryAttempt: number;
  terminalCommitted: boolean;
  persistedPublished: boolean;
  terminalOutcome?: TurnOutcome;
  releaseStarted: boolean;
  /** The release scheduled by the committed Ended; a provider can start its next turn before it finishes. */
  terminalRelease?: Promise<void>;
  deliveryFailed?: boolean;
  deliveryFailureHandling?: Promise<void>;
  stopInProgress?: boolean;
  stopRequested?: boolean;
  lastRetries?: ObservedProviderRetries;
}

/** Read-only runtime state available to server-owned diagnostics and recovery infrastructure. */
export interface AgentRuntimeAccess {
  /** Return the number of active agent sessions. */
  activeCount(): number;
  /** Return all active runtime thread identities. */
  activeThreadIds(): string[];
  /** Return immutable runtime snapshots. */
  runtimeSnapshots(): TurnRuntimeSnapshot[];
}

export type { SendMessageCommand } from "../turns/turn-admission-dispatch-coordinator.js";
export type { CreateAndSendCommand } from "../turns/thread-creation-coordinator.js";

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class TurnRuntimeController implements TurnLifecycleControl, TurnRuntimeEventControl {
  /** Canonical per-thread execution identity and lifecycle authority. */
  private readonly turnRuntime = new TurnRuntimeRegistry();
  private readonly activeSessionIds = new Set<string>();
  private initialized = false;
  /** Set once graceful shutdown begins; the process exits afterward, so it never resets. */
  private shuttingDown = false;
  /**
   * Classifies a failed send as transient or fatal and caps the automatic
   * retry, so a brief flake doesn't cost the user a manual re-send while a
   * misclassified fatal error can't loop.
   */
  private readonly turnErrorPolicy = new TurnErrorPolicy();
  /**
   * Threads with a transient-failure retry in flight. While a thread is armed,
   * a transient `Error` event from the failed attempt is hidden from the UI (the
   * broadcast in the composition root and the errored-finalize here both consult
   * {@link shouldSuppressTransientTurnError}). The retry's fresh attempt then
   * surfaces normally, so the user never sees the swallowed flake. Disarmed on
   * success or just before the final-failure emit, so a give-up still shows.
   */
  private readonly retryingThreads = new Set<string>();
  /**
   * Threads whose failed-attempt teardown events (`Ended`, `TurnComplete`) must
   * be swallowed during a transient retry. Without this the failed attempt would
   * tear down the UI's running state (spinner off, partial stream committed)
   * before the retry streams, producing a visible gap. Armed when a transient
   * `Error` is suppressed and again at the start of each retry catch (before
   * `discardSession`, which can emit a trailing `Ended` without a preceding
   * `Error`). Consulted by {@link shouldSuppressTurnEnded} and
   * {@link shouldSuppressTurnComplete}; cleared only after pooled-session
   * eviction drains (or immediately when no session existed), on success, or on
   * give-up so the retry's own terminal events still reach the UI.
   */
  private readonly endedSuppressionThreads = new Set<string>();
  /** Callbacks keyed by turn execution that run once that runtime releases its active slot, so follow-up turns can admit. */
  private readonly runtimeReleaseCallbacks = new Map<string, (cause?: RuntimeReleaseCause) => void>();
  private readonly runtimeReleaseListeners = new Set<(threadId: string) => void>();
  /**
   * Per-thread dispatch state for transient retries. Fire-and-forget providers
   * A provider can return from `sendTurn` before the stream ends, so the retry
   * window must stay armed until `TurnComplete` and stream failures must be
   * able to re-dispatch from the `Error` handler rather than only from the
   * `sendTurn` catch.
   */
  private readonly turnRetryDispatchByThread = new Map<
    string,
    {
      attempt: number;
      retryInFlight: boolean;
      /** False once the in-flight `sendTurn` promise has settled (success or throw). */
      sendTurnInFlight: boolean;
      /** True once the provider's sendTurn invocation has begun. */
      dispatchStarted: boolean;
      sessionName: string;
      resolvedProvider: import("@mcode/contracts/providers/interfaces").IAgentProvider;
      effectiveProvider: ProviderId;
      /** Provider-neutral thread-control activation selected during admission. */
      threadControl: ThreadControlLeaseDirective | null;
      turnRequest: TurnRequest;
      /** Shared mutation token required for every provider dispatch and release. */
      mutationReservationToken: string;
      /** Monotonic turn generation used to reject stale retry callbacks. */
      generation: number;
      /** Opaque command-effect receipt retained until terminal success or retry exhaustion. */
      commandEffect: CommandEffectReceipt | null;
    }
  >();
  /** Reservation token attached to each active provider turn. */
  private readonly activeMutationReservations = new Map<string, string>();
  /** Single-flight user stop operation per thread. */
  private readonly stopOperationsByThread = new Map<string, Promise<AgentStopResult>>();
  /** Monotonic turn generation per thread, including turns that failed setup. */
  private readonly turnGenerations = new Map<string, number>();
  /** Single ordered pipeline for validated provider envelopes and terminal materialization. */
  private readonly turnEventPipeline: TurnEventPipeline;
  private readonly workerTurns = new Map<string, WorkerOwnedTurn>();
  constructor(
    @inject(TURN_RUNTIME_PERSISTENCE)
    private readonly runtimePersistence: TurnRuntimePersistence,
    @inject("TurnFileTracker")
    private readonly turnFileTracker: TurnFileTracker,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR)
    private readonly turnAdmissions: TurnAdmissionDispatchCoordinator,
    @inject(ThreadCreationCoordinator)
    private readonly threadCreation: ThreadCreationCoordinator,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(MemoryPressureService)
    private readonly memoryPressureService: MemoryPressureService,
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService,
    @inject(delay(() => McodeSessionAuthority))
    private readonly threadControlMcp: McodeSessionAuthority | undefined,
    @inject(delay(() => ThreadControlMutationReservationService))
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject(ProviderEventIngress)
    private readonly providerEventIngress: ProviderEventIngress,
    @inject(TURN_FEATURE_EFFECTS)
    private readonly featureEffects: TurnFeatureEffects,
    @inject(AgentRuntimeCommandPort)
    runtimeCommands: AgentRuntimeCommandPort,
    @inject(AgentEventPublicationRuntimePort)
    publicationRuntime: AgentEventPublicationRuntimePort,
    @inject(AgentEventPublicationRegistry)
    private readonly eventPublication: AgentEventPublicationRegistry,
    @inject(TurnDiffService) turnDiffs: TurnDiffService,
    @inject(TurnSteerRuntimePort) steering: TurnSteerRuntimePort,
    @inject(ProviderSwitchService) providerSwitch: ProviderSwitchService,
    @inject("WorkerOwnedTurnRuntime", { isOptional: true })
    private readonly workerRuntime?: WorkerOwnedTurnRuntime,
    @inject("ExecutionFileEvidenceCoordinator", { isOptional: true })
    private readonly workerFiles?: ExecutionFileEvidenceCoordinator,
    @inject("WorkerTurnSnapshotService", { isOptional: true })
    private readonly snapshots?: SnapshotService,
    // A class token is always constructible, so `isOptional` only takes effect on a string alias.
    @inject("TurnRuntimeSnapshotRefPins", { isOptional: true })
    private readonly pins?: SnapshotRefPins,
  ) {
    this.turnEventPipeline = new TurnEventPipeline(this, {
      publishCommitted: (event) => this.eventPublication.publish(event),
    }, turnDiffs,
      workerRuntime && workerFiles ? {
        ownsFileMutation: (event) => Boolean(workerRuntime.owner.current(event.threadId)?.started),
        capture: (event) => workerFiles.capture(event),
      } : undefined);
    providerSwitch.bindDispatch((command) => this.sendMessage(command));
    runtimeCommands.bind({
      createAndSend: (command, options) => this.createAndSend(command, options),
      sendMessage: (command) => this.sendMessage(command),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    });
    publicationRuntime.bind({
      getCurrentFileEffectTurnId: (threadId) => this.getCurrentFileEffectTurnId(threadId),
      shouldSuppressTurnEnded: (threadId) => this.shouldSuppressTurnEnded(threadId),
      shouldSuppressTurnComplete: (threadId) => this.shouldSuppressTurnComplete(threadId),
      shouldSuppressTransientTurnError: (threadId, errorMessage) => (
        this.shouldSuppressTransientTurnError(threadId, errorMessage)
      ),
    });
    steering.bind({
      runningTurn: (threadId) => this.steerableTurn(threadId),
      recordDelivered: (message) => {
        const progress = this.workerRuntime?.progress;
        if (!progress) return Promise.reject(new Error("Steered messages need the worker-owned turn runtime"));
        return progress.acceptSteeredUserMessage(message);
      },
    });
    workerRuntime?.providerEvents.bindCommandPreparation((execution, batch) => this.prepareWorkerEvent(execution, batch));
    workerRuntime?.providerEvents.bindCommitted((execution, result) => this.applyWorkerReceipt(execution, result));
    workerRuntime?.bindRecovered((execution) => this.handleWorkerRecovery(execution));
    this.eventPublication.registerPipelineStart(() => this.initializeProviderEvents());
  }

  /** The running worker turn a steer may join. A stopping or finishing turn takes no new messages. */
  private steerableTurn(threadId: string): SteerableTurn | null {
    const owned = this.workerTurns.get(threadId);
    if (!owned || !this.acceptsNewInput(threadId, owned)) return null;
    const provider = owned.provider;
    const turn = { sessionId: owned.prepared.request.sessionId, threadId, turnExecutionId: owned.execution.executionId };
    return {
      turnExecutionId: turn.turnExecutionId,
      workspaceId: owned.prepared.request.workspaceId,
      providerId: provider.id,
      holdsDelegationLease: owned.prepared.threadControl !== null,
      steer: isTurnSteerCapable(provider) ? (input) => provider.steerTurn({ ...turn, ...input }) : null,
    };
  }

  private acceptsNewInput(threadId: string, owned: WorkerOwnedTurn): boolean {
    const snapshot = this.turnRuntime.snapshot(threadId);
    if (snapshot?.phase !== "running" || snapshot.turnExecutionId !== owned.execution.executionId) return false;
    if (owned.terminalCommitted || owned.stopRequested || owned.stopInProgress) return false;
    return this.mutationReservations.get(threadId)?.state !== "stopping";
  }

  /** Return the server tracker generation that owns live file effects for a thread. */
  private getCurrentFileEffectTurnId(threadId: string): string | undefined {
    return this.turnFileTracker.getCurrentTurnId(threadId);
  }

  /**
   * The provider running the thread's current turn. A switching send keeps the persisted provider until the
   * target accepts the turn, so stop and teardown must follow the dispatch, not the thread row.
   */
  private activeProviderId(threadId: string): ProviderId | undefined {
    return this.turnRetryDispatchByThread.get(threadId)?.effectiveProvider
      ?? this.runtimePersistence.load(threadId)?.provider as ProviderId | undefined;
  }

  /** Mark an admitted provider turn active for memory-pressure accounting. */
  markProviderTurnActive(threadId: string): void {
    if (this.activeSessionIds.has(threadId)) return;
    this.activeSessionIds.add(threadId);
    this.memoryPressureService.markActive(threadId);
  }

  /** Return the authoritative runtime state for one thread. */
  snapshot(threadId: string): TurnRuntimeSnapshot | undefined {
    return this.turnRuntime.snapshot(threadId);
  }

  /** Observe release even when admission failed before any terminal event existed. */
  onRuntimeReleased(listener: (threadId: string) => void): () => void {
    this.runtimeReleaseListeners.add(listener);
    return () => { this.runtimeReleaseListeners.delete(listener); };
  }

  /** The cause of a provider-reported interruption: Mcode's own shutdown stops providers, which report it as their own. */
  providerInterruptionEnding(): TurnEndingCause {
    return { cause: this.shuttingDown ? "app_closed" : "provider_exited" };
  }

  /** Stop the active provider when its event state cannot become durable. */
  stopForEventApplicationFailure(event: AgentEvent, reason: string): void {
    const executionId = event.turnExecutionId;
    if (!executionId || !isActiveRuntimeExecution(this.turnRuntime.snapshot(event.threadId) ?? null, executionId)) return;
    logger.error(reason, { threadId: event.threadId, turnExecutionId: executionId, eventType: event.type });
    let providerId: ProviderId | undefined;
    try {
      providerId = this.activeProviderId(event.threadId);
    } catch (error) {
      logger.warn("Provider lookup failed after event application failure", {
        threadId: event.threadId,
        turnExecutionId: executionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (providerId) {
      try {
        void Promise.resolve(this.providerRegistry.resolve(providerId).stopSession(`mcode-${event.threadId}`)).catch((error) => {
          logger.warn("Provider stop failed after event application failure", {
            threadId: event.threadId,
            turnExecutionId: executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        logger.warn("Provider resolution failed after event application failure", {
          threadId: event.threadId,
          turnExecutionId: executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.disarmTurnRetryWindow(event.threadId);
  }

  /** Stop a provider stream that the runtime cannot admit. */
  private stopUnadmittedTurn(threadId: string, providerId: ProviderId | undefined, reason: string): void {
    logger.warn("Ignoring TurnStarted that the runtime did not admit", { threadId, providerId, reason });
    if (!providerId) return;
    try {
      void Promise.resolve(this.providerRegistry.resolve(providerId).stopSession(`mcode-${threadId}`)).catch((error) => {
        logger.warn("Failed to stop unadmitted provider turn", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn("Failed to resolve provider for unadmitted turn", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private runtimeAdmissionAuthority(): TurnRuntimeAdmissionAuthority {
    return {
      reserve: (command) => this.reserveTurnAdmission(command),
      activate: (lease) => this.activateTurnAdmission(lease),
      abort: (lease) => this.abortTurnAdmission(lease),
      release: (lease) => this.releaseTurnAdmission(lease),
      owns: (lease) => this.ownsTurnAdmission(lease),
    };
  }

  /** Reserve one runtime generation and its mutation lease for a new admitted turn. */
  private reserveTurnAdmission(command: SendMessageCommand): TurnRuntimeLease {
    if (!this.reserveTurn(command.threadId)) {
      throw new Error(`Thread ${command.threadId} already has an active agent session`);
    }
    const token = this.reserveMutationToken(command);
    if (!token) {
      this.activeSessionIds.delete(command.threadId);
      throw new Error(`Thread ${command.threadId} already has a pending mutation`);
    }
    const generation = (this.turnGenerations.get(command.threadId) ?? 0) + 1;
    this.turnGenerations.set(command.threadId, generation);
    const turnExecutionId = this.turnRuntime.start(command.threadId).turnExecutionId!;
    this.activeMutationReservations.set(command.threadId, token);
    if (command.onRuntimeReleased) this.runtimeReleaseCallbacks.set(turnExecutionId, command.onRuntimeReleased);
    command.onTurnStarted?.({ threadId: command.threadId, turnExecutionId, phase: "running" });
    return { threadId: command.threadId, turnExecutionId, mutationReservationToken: token, generation };
  }

  /** Reuse an approved mutation lease or reserve one for a normal composer turn. */
  private reserveMutationToken(command: SendMessageCommand): string | null {
    if (!command.mutationReservationToken) {
      return this.mutationReservations.reserve(command.threadId, "activeTurn");
    }
    return this.mutationReservations.owns(command.threadId, command.mutationReservationToken, "activeTurn")
      ? command.mutationReservationToken
      : null;
  }

  /** Mark a leased runtime active only after admission has validated its durable setup. */
  private activateTurnAdmission(lease: TurnRuntimeLease): void {
    if (!this.ownsTurnAdmission(lease)) {
      throw new Error(`Turn admission lost runtime ownership: ${lease.threadId}`);
    }
    this.memoryPressureService.markActive(lease.threadId);
  }

  /** Release a failed admission without disturbing a replacement turn that won the lease. */
  private releaseTurnAdmission(lease: TurnRuntimeLease): void {
    const ownsRuntime = this.turnRuntime.snapshot(lease.threadId)?.turnExecutionId === lease.turnExecutionId;
    const ownsMutation = this.activeMutationReservations.get(lease.threadId) === lease.mutationReservationToken;
    if ((ownsRuntime || ownsMutation) && this.activeSessionIds.delete(lease.threadId)) {
      this.memoryPressureService.markIdle(lease.threadId);
    }
    if (ownsMutation) this.activeMutationReservations.delete(lease.threadId);
    this.mutationReservations.release(lease.threadId, lease.mutationReservationToken);
    // A failed admission never reaches `trackSessionEnded`, so waiters on the release (a switch's event
    // subscription, a queued turn's completion) would otherwise never be told.
    const released = this.runtimeReleaseCallbacks.get(lease.turnExecutionId);
    this.runtimeReleaseCallbacks.delete(lease.turnExecutionId);
    released?.("admission-failed");
    for (const listener of this.runtimeReleaseListeners) listener(lease.threadId);
  }

  /** Terminalize an admitted turn when durable admission cannot complete. */
  private async abortTurnAdmission(lease: TurnRuntimeLease): Promise<void> {
    const finishedDurably = await this.finishUnsentWorkerTurn(lease.threadId, lease.turnExecutionId);
    const terminalizedRuntime = this.turnRuntime.terminalize(lease.threadId, lease.turnExecutionId, "errored");
    if (!finishedDurably && !terminalizedRuntime) return;
    this.disarmTurnRetryWindow(lease.threadId);
    this.trackSessionEnded(lease.threadId, lease.turnExecutionId);
  }

  /** Check exact runtime generation and reservation ownership before provider work. */
  private ownsTurnAdmission(lease: TurnRuntimeLease): boolean {
    return this.ownsActiveTurnExecution(
      lease.threadId,
      lease.turnExecutionId,
      lease.mutationReservationToken,
    );
  }

  /** Set up generic turn tracking, apply a stable command receipt, then send through the provider. */
  private async dispatchPreparedTurn(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) {
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    try {
      await this.prepareRuntimeDispatch(prepared);
      await this.activatePreparedCommandEffect(prepared);
      await this.startPreparedProviderDispatch(prepared);
    } catch (error) {
      logger.error("Prepared turn dispatch failed", { threadId: prepared.lease.threadId,
        error: error instanceof Error ? error.message : String(error) });
      await this.failPreparedTurnDispatch(prepared, error);
    }
  }

  /** Bind file evidence and the exact provider route after the parent start receipt. */
  private async prepareRuntimeDispatch(prepared: PreparedTurnDispatch): Promise<void> {
    const worker = this.requireWorkerRuntime();
    const files = this.requireWorkerFiles();
    const snapshots = this.snapshots;
    if (!snapshots) throw new Error("Worker-owned turn requires snapshot service");
    const execution = this.executionFor(prepared);
    const provider = prepared.provider;
    let baselineRef: string | null = null;
    try {
      baselineRef = this.pins
        ? (await this.pins.captureBaseline(prepared.cwd, execution.threadId, execution.executionId)).tree
        : await snapshots.captureRef(prepared.cwd);
    } catch (error) {
      logger.warn("Could not capture initial turn snapshot", {
        threadId: execution.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.ownsTurnAdmission(prepared.lease)) throw new Error("Worker turn lost admission during file preparation");
    const handoff = files.begin({ ...execution, deliveryAttempt: 1, cwd: prepared.cwd, baselineRef });
    const began = await worker.owner.submit(execution, {
      kind: "begin-files", cwd: prepared.cwd, handoff, deliveryAttempt: 1,
    });
    if (began.kind !== "committed" && began.kind !== "accepted") throw new Error("Worker file handoff was not committed");
    this.markProviderTurnActive(execution.threadId);
    await worker.providerEvents.bind(execution, 1);
    this.workerTurns.set(execution.threadId, {
      execution, prepared, provider, deliveryAttempt: 1,
      terminalCommitted: false, persistedPublished: false, releaseStarted: false,
    });
    if (provider.id === "codex") {
      const codex = this.codexProvider(provider);
      codex.setCanonicalTurnDeliveryFailureHandler((routing, error) => this.handleWorkerDeliveryFailure(routing, error));
    }
    await this.turnAdmissions.markDispatchActive(execution.threadId);
  }

  private executionFor(prepared: PreparedTurnDispatch): ExecutionIdentity {
    return {
      threadId: prepared.lease.threadId,
      turnId: prepared.request.turnId,
      executionId: prepared.lease.turnExecutionId,
    };
  }

  private codexProvider(provider: IAgentProvider): CodexProviderBoundary {
    if (provider.id !== "codex" || !("retireCanonicalTurnEvents" in provider)
      || !("fenceCanonicalTurnEvents" in provider)) {
      throw new Error("Codex provider has no worker-owned event route");
    }
    return provider as CodexProviderBoundary;
  }

  private requireWorkerRuntime(): WorkerOwnedTurnRuntime {
    if (!this.workerRuntime) throw new Error("Worker-owned turn runtime is unavailable");
    return this.workerRuntime;
  }

  private fenceWorkerProvider(provider: IAgentProvider, execution: ExecutionIdentity, deliveryAttempt: number,
    discardQueued = false): Promise<void> {
    return provider.id === "codex"
      ? this.codexProvider(provider).fenceCanonicalTurnEvents({ ...execution, deliveryAttempt }, { discardQueued })
      : this.requireWorkerRuntime().providerEvents.fence(execution);
  }

  private retireWorkerProvider(provider: IAgentProvider, execution: ExecutionIdentity, deliveryAttempt: number): Promise<void> {
    return provider.id === "codex"
      ? this.codexProvider(provider).retireCanonicalTurnEvents({ ...execution, deliveryAttempt }) : Promise.resolve();
  }

  private requireWorkerFiles(): ExecutionFileEvidenceCoordinator {
    if (!this.workerFiles) throw new Error("Worker-owned file capture is unavailable");
    return this.workerFiles;
  }

  /** Attach host-captured evidence before the exact provider batch enters its mailbox. */
  private async prepareWorkerEvent(
    execution: ExecutionIdentity,
    batch: WorkerOwnedProviderEventBatch,
  ): Promise<Extract<ExecutionWorkCommand, { kind: "event" }>> {
    const active = this.requireActiveWorkerTurn(execution, batch.deliveryAttempt);
    const event = this.parentRuntimeEvent(batch);
    const fileObservation = event?.type === "toolUse"
      ? this.takeOptionalFileObservation(event, batch.deliveryAttempt) : null;
    observeWorkerRetries(active, event);
    const terminal = event ? this.prepareTerminalWorkerEvent(active, event) : null;
    return {
      kind: "event", phase: batch.phase, nativeCursor: batch.nativeCursor ?? null,
      events: batch.events, deliveryAttempt: batch.deliveryAttempt,
      ...(fileObservation ? { capturedFileObservation: fileObservation } : {}),
      ...(terminal ? { terminalInput: terminal.input } : {}),
      ...(terminal?.files ? { frozenFileEvidence: terminal.files } : {}),
    };
  }

  private takeOptionalFileObservation(event: Extract<AgentEvent, { type: "toolUse" }>, attempt: number) {
    try {
      return this.requireWorkerFiles().take(event, attempt);
    } catch (error) {
      logger.warn("Provider file capture unavailable", { threadId: event.threadId, executionId: event.turnExecutionId,
        deliveryAttempt: attempt, errorType: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  }

  private requireActiveWorkerTurn(execution: ExecutionIdentity, attempt: number): WorkerOwnedTurn {
    const active = this.workerTurns.get(execution.threadId);
    if (!active || active.execution.executionId !== execution.executionId
      || active.deliveryAttempt !== attempt) {
      throw new Error("Provider event has no matching worker-owned turn");
    }
    return active;
  }

  private parentRuntimeEvent(batch: WorkerOwnedProviderEventBatch): AgentEvent | null {
    if (batch.events.length !== 1) return null;
    const draft = batch.events[0];
    if (!draft || draft.payload.type !== "item.recorded") return null;
    const payload = draft.payload.item.payload;
    if (payload.projection !== "providerRuntimeEvent") return null;
    const parsed = ProviderRuntimeEventSchema().safeParse(payload.runtimeEvent);
    if (!parsed.success) throw new Error("Worker event has an invalid provider runtime payload");
    if (writerOwnedProviderExtension(parsed.data.extension)) return null;
    const event = parsed.data.event;
    if (!matchesWorkerEvent(event, batch)) {
      throw new Error("Worker event belongs to a different execution");
    }
    return event;
  }

  private prepareTerminalWorkerEvent(active: WorkerOwnedTurn, event: AgentEvent) {
    const outcome = workerTerminalOutcome(event);
    return outcome ? this.prepareWorkerTerminal(active, outcome, event) : null;
  }

  private prepareWorkerTerminal(active: WorkerOwnedTurn, outcome: TurnOutcome, event: AgentEvent): {
    input: DataOnlyParentTurnFinishInput;
    files: ReturnType<ExecutionFileEvidenceCoordinator["seal"]>;
  } {
    const ending = workerProviderEnding(active, outcome, event, this.providerInterruptionEnding());
    const files = this.sealOptionalFileEvidence(active, outcome);
    if (!files) logger.warn("Provider terminal file evidence unavailable", { threadId: active.execution.threadId,
      executionId: active.execution.executionId, deliveryAttempt: active.deliveryAttempt });
    return {
      files,
      input: {
        ...active.execution,
        providerId: active.prepared.providerId,
        providerIdentities: active.prepared.parentStartInput.providerIdentities,
        outcome,
        deliveryAttempt: active.deliveryAttempt,
        projection: { kind: "writer-staged" },
        ...(ending ? { ending } : {}),
      },
    };
  }

  private sealOptionalFileEvidence(active: WorkerOwnedTurn, outcome: TurnOutcome): ReturnType<ExecutionFileEvidenceCoordinator["seal"]> {
    try {
      return this.requireWorkerFiles().seal({ ...active.execution, deliveryAttempt: active.deliveryAttempt, outcome });
    } catch (error) {
      logger.warn("Provider terminal file capture failed", { threadId: active.execution.threadId,
        executionId: active.execution.executionId, errorType: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  }

  /** Update volatile runtime state only after the semantic writer has acknowledged the event. */
  private async applyWorkerReceipt(
    execution: ExecutionIdentity,
    result: Extract<ExecutionWorkerResult, { kind: "committed" | "accepted" }>,
  ): Promise<void> {
    const active = this.workerTurns.get(execution.threadId);
    if (!active || active.execution.executionId !== execution.executionId) return;
    const event = result.parentEvent?.publication.event;
    if (!event) return;
    this.applyWorkerTerminalReceipt(active, event);
    try {
      this.applyWorkerFeatureReceipt(active, result);
      this.publishWorkerPersistence(active, result);
    } catch (error) {
      logger.warn("Accepted provider event side effect failed", { threadId: execution.threadId,
        executionId: execution.executionId, eventType: event.type, errorType: error instanceof Error ? error.name : "unknown" });
    }
    if (event.type === "ended") {
      // The callback still belongs to the route's pending set. Release on the next task.
      active.terminalRelease = new Promise<void>((resolve) => { setTimeout(resolve, 0); })
        .then(() => this.releaseWorkerTurn(active));
      active.terminalRelease.catch((error: unknown) => {
        logger.error("Worker-owned terminal release failed", { threadId: execution.threadId,
          error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  private applyWorkerFeatureReceipt(
    active: WorkerOwnedTurn,
    result: Extract<ExecutionWorkerResult, { kind: "committed" | "accepted" }>,
  ): void {
    this.reportWorkerPlanOutcome(active.execution.threadId, result);
    const event = result.parentEvent?.publication.event;
    if (event?.type === "message" && active.prepared.providerId === "codex") {
      this.featureEffects.onAssistantMessage("codex", event);
    }
    for (const intent of result.parentEvent?.runtime ?? []) {
      if (intent.kind === "plan-captured") this.featureEffects.onPlanPersisted(active.execution.threadId);
      if (intent.kind === "assistant-message-feature") {
        this.featureEffects.onAssistantMessage(active.prepared.providerId, intent.event);
      }
    }
  }

  private reportWorkerPlanOutcome(
    threadId: string,
    result: Extract<ExecutionWorkerResult, { kind: "committed" | "accepted" }>,
  ): void {
    for (const intent of result.parentEvent?.runtime ?? []) {
      if (intent.kind === "plan-capture-outcome" && intent.outcome === "missing") {
        logger.warn("Planning turn produced no plan", { threadId, outcome: intent.outcome });
      }
    }
  }

  private applyWorkerTerminalReceipt(active: WorkerOwnedTurn, event: AgentEvent): void {
    if (event.type === "turnStarted") this.markProviderTurnActive(event.threadId);
    const outcome = workerTerminalOutcome(event);
    if (!outcome) return;
    active.terminalCommitted = true;
    active.terminalOutcome = outcome;
    this.turnRuntime.terminalize(active.execution.threadId, active.execution.executionId, outcome);
  }

  private publishWorkerPersistence(
    active: WorkerOwnedTurn | undefined,
    result: Extract<ExecutionWorkerResult, { kind: "committed" | "accepted" }>,
  ): void {
    if (!active) return;
    const persisted = result.kind === "committed" ? result.terminalPersistence : undefined;
    if (!persisted || active.persistedPublished) return;
    active.persistedPublished = true;
    publishTurnPersisted(active.execution, persisted);
  }

  private async releaseWorkerTurn(active: WorkerOwnedTurn): Promise<void> {
    if (active.releaseStarted || active.stopInProgress || !active.terminalCommitted) return;
    active.releaseStarted = true;
    const { execution, provider, deliveryAttempt } = active;
    try {
      if (active.deliveryFailed) {
        await this.fenceWorkerProvider(provider, execution, deliveryAttempt).catch(() => {});
        await this.retireWorkerProvider(provider, execution, deliveryAttempt).catch(() => {});
      } else {
        await this.fenceWorkerProvider(provider, execution, deliveryAttempt);
        await this.retireWorkerProvider(provider, execution, deliveryAttempt);
      }
      await this.requireWorkerRuntime().providerEvents.retire(execution);
      await this.requireWorkerRuntime().owner.release(execution);
      this.requireWorkerFiles().retire(execution.threadId, execution.executionId, deliveryAttempt);
      if (this.workerTurns.get(execution.threadId) === active) this.workerTurns.delete(execution.threadId);
      this.trackSessionEnded(execution.threadId, execution.executionId);
      if (active.terminalOutcome === "completed") this.featureEffects.refreshAfterTurn(execution.threadId);
      this.disarmTurnRetryWindow(execution.threadId);
      this.clearTurnEndedState(execution.threadId);
      this.settlePinsInBackground(execution);
    } catch (error) {
      active.releaseStarted = false;
      await this.requireWorkerRuntime().recoverRejected(execution);
      throw error;
    }
  }

  /** Git work must not hold the thread after release; pin failures are logged, never thrown. */
  private settlePinsInBackground(execution: ExecutionIdentity): void {
    const pins = this.pins;
    pins?.runInBackground(() => pins.settleExecution(execution.threadId, execution.executionId));
  }

  private handleWorkerRecovery(execution: ExecutionIdentity): void {
    // Recovery has committed the interruption, so the baseline can become the attempt's snapshot.
    this.settlePinsInBackground(execution);
    if (this.turnRuntime.snapshot(execution.threadId)?.turnExecutionId !== execution.executionId) return;
    const active = this.workerTurns.get(execution.threadId);
    if (active && active.execution.executionId !== execution.executionId) return;
    if (active) this.workerTurns.delete(execution.threadId);
    if (active) this.recoverWorkerProvider(active);
    this.turnRuntime.terminalize(execution.threadId, execution.executionId, "interrupted");
    this.trackSessionEnded(execution.threadId, execution.executionId);
    this.disarmTurnRetryWindow(execution.threadId);
    this.clearTurnEndedState(execution.threadId);
  }

  private recoverWorkerProvider(active: WorkerOwnedTurn): void {
    const { execution } = active;
    void this.fenceWorkerProvider(active.provider, execution, active.deliveryAttempt).catch((error: unknown) => {
      logger.warn("Recovered worker provider fence failed", { threadId: execution.threadId,
        error: error instanceof Error ? error.message : String(error) });
    });
    void this.requireWorkerRuntime().providerEvents.retire(execution).catch((error: unknown) => {
      logger.warn("Recovered worker provider route cleanup failed", { threadId: execution.threadId,
        error: error instanceof Error ? error.message : String(error) });
    });
    this.requireWorkerFiles().retire(execution.threadId, execution.executionId, active.deliveryAttempt);
    void Promise.resolve(active.provider.stopSession(active.prepared.request.sessionId)).catch((error: unknown) => {
      logger.warn("Recovered worker provider stop failed", { threadId: execution.threadId,
        error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Activate command-specific state only after the runtime can still dispatch. */
  private async activatePreparedCommandEffect(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) {
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    await this.turnAdmissions.activateCommandEffect(prepared.commandEffect);
    if (!this.ownsTurnAdmission(prepared.lease)) {
      await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
      this.releaseTurnAdmission(prepared.lease);
    }
  }

  /** Register retry state and issue the initial provider send. */
  private async startPreparedProviderDispatch(prepared: PreparedTurnDispatch): Promise<void> {
    if (!this.ownsTurnAdmission(prepared.lease)) return;
    this.applyThreadControlLease(prepared.threadControl);
    const dispatch = this.createRetryDispatch(prepared);
    this.turnRetryDispatchByThread.set(prepared.lease.threadId, dispatch);
    this.retryingThreads.add(prepared.lease.threadId);
    this.bindClaudeCanonicalDelivery(prepared.provider);
    if (prepared.dispatchRefusal) return this.handleInitialDispatchFailure(prepared.lease.threadId, dispatch, prepared.dispatchRefusal);
    if (prepared.replaceSession) await this.replacePooledSession(prepared);
    await this.sendPreparedDispatch(prepared.lease.threadId, dispatch);
  }

  /** Evict the pooled session while suppressing its teardown `Ended`, which would otherwise end the new turn. */
  private async replacePooledSession(prepared: PreparedTurnDispatch): Promise<void> {
    const threadId = prepared.lease.threadId;
    this.endedSuppressionThreads.add(threadId);
    try {
      await this.evictPooledSession(prepared.provider, prepared.request.sessionId);
    } finally {
      this.endedSuppressionThreads.delete(threadId);
    }
  }

  private bindClaudeCanonicalDelivery(provider: IAgentProvider): void {
    if (!hasClaudeCanonicalDelivery(provider)) return;
    provider.setCanonicalTurnDeliveryFailureHandler((routing, error) => this.handleClaudeDeliveryFailure(routing, error));
  }

  private async handleClaudeDeliveryFailure(routing: ClaudeCanonicalEventRouting, error: Error): Promise<void> {
    const dispatch = this.turnRetryDispatchByThread.get(routing.threadId);
    if (!dispatch || dispatch.effectiveProvider !== "claude"
      || dispatch.turnRequest.turnId !== routing.turnId
      || dispatch.turnRequest.turnExecutionId !== routing.executionId
      || (dispatch.turnRequest.deliveryAttempt ?? 1) !== routing.deliveryAttempt) return;
    const identity = this.retryDispatchIdentity(dispatch);
    if (!this.getCurrentRetryDispatch(routing.threadId, identity)) return;
    if (this.workerTurns.has(routing.threadId)) return this.handleWorkerDeliveryFailure(routing, error);

  }

  /** Construct runtime-owned retry state from an immutable dispatch package. */
  private createRetryDispatch(prepared: PreparedTurnDispatch) {
    return {
      attempt: 1,
      retryInFlight: false,
      sendTurnInFlight: false,
      dispatchStarted: false,
      sessionName: prepared.request.sessionId,
      resolvedProvider: prepared.provider,
      effectiveProvider: prepared.providerId,
      threadControl: prepared.threadControl,
      turnRequest: prepared.request,
      commandEffect: prepared.commandEffect,
      mutationReservationToken: prepared.lease.mutationReservationToken,
      generation: prepared.lease.generation,
    };
  }

  /** Apply the provider-neutral thread-control directive selected during admission. */
  private applyThreadControlLease(directive: ThreadControlLeaseDirective | null): void {
    if (directive) this.threadControlMcp?.activate(directive);
  }

  /** Send one attempt and hand only retryable failures to the existing retry owner. */
  private async sendPreparedDispatch(
    threadId: string,
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
  ): Promise<void> {
    dispatch.sendTurnInFlight = true;
    try {
      await this.sendProviderTurn(threadId, dispatch);
      dispatch.sendTurnInFlight = false;
      logger.info("Message sent via provider", {
        threadId,
        session: dispatch.sessionName,
        model: dispatch.turnRequest.model,
      });
    } catch (error) {
      dispatch.sendTurnInFlight = false;
      await this.handleInitialDispatchFailure(threadId, dispatch, error);
    }
  }

  /** Invoke a provider only while its AgentService mutation lease remains current. */
  private async sendProviderTurn(
    threadId: string,
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
  ): Promise<void> {
    if (typeof dispatch.turnRequest.turnExecutionId !== "string") {
      throw new Error("Turn execution identity required at provider dispatch boundary");
    }
    const send = this.mutationReservations.runIfOwned(
      threadId,
      dispatch.mutationReservationToken,
      "activeTurn",
      () => {
        dispatch.dispatchStarted = true;
        return dispatch.resolvedProvider.sendTurn(dispatch.turnRequest);
      },
    );
    if (send === undefined) return;
    await send;
  }

  private async handleInitialDispatchFailure(
    threadId: string,
    dispatch: ReturnType<TurnRuntimeController["createRetryDispatch"]>,
    error: unknown,
  ): Promise<void> {
    if (!this.mutationReservations.owns(threadId, dispatch.mutationReservationToken, "activeTurn")) return;
    const workerTurn = this.workerTurns.get(threadId);
    if (workerTurn) {
      try {
        await this.failWorkerDispatch(workerTurn, error);
      } catch (failure) {
        logger.error("Worker dispatch failed before terminal recovery", { threadId,
          executionId: workerTurn.execution.executionId,
          error: error instanceof Error ? error.message : String(error),
          recoveryError: failure instanceof Error ? failure.message : String(failure) });
        await this.requireWorkerRuntime().recoverRejected(workerTurn.execution);
        throw error;
      }
      return;
    }
  }

  private async failWorkerDispatch(active: WorkerOwnedTurn, error: unknown): Promise<void> {
    const { execution, deliveryAttempt, provider } = active;
    this.requireWorkerFiles().fence(execution.threadId, execution.executionId, deliveryAttempt);
    if (active.deliveryFailed) {
      await this.fenceWorkerProvider(provider, execution, deliveryAttempt).catch(() => {});
    } else {
      await this.fenceWorkerProvider(provider, execution, deliveryAttempt);
    }
    if (active.terminalCommitted) return this.releaseWorkerTurn(active);
    const message = error instanceof Error ? error.message : String(error);
    const { outcome, ending } = providerFailureTerminal(persistTurnFailure({ failure: dispatchFailure(error),
      provider: active.prepared.providerId, message, acceptedAt: Date.now(),
      ...(active.lastRetries ? { lastRetries: active.lastRetries } : {}) }));
    const frozen = this.requireWorkerFiles().seal({ ...execution, deliveryAttempt, outcome });
    if (!frozen) throw new Error("Failed worker dispatch lost its file evidence generation");
    const result = await this.requireWorkerRuntime().owner.submit(execution, {
      kind: "finish-from-state", outcome, frozenFileEvidence: frozen,
      input: { ...execution, providerId: active.prepared.providerId,
        providerIdentities: active.prepared.parentStartInput.providerIdentities,
        outcome, error: message, ending,
        deliveryAttempt, projection: { kind: "writer-staged" } },
    });
    if (result.kind !== "committed" && result.kind !== "accepted") throw new Error("Failed worker dispatch terminal did not commit");
    this.publishWorkerPersistence(active, result);
    active.terminalCommitted = true;
    active.terminalOutcome = outcome;
    this.turnRuntime.terminalize(execution.threadId, execution.executionId, outcome);
    await this.releaseWorkerTurn(active);
  }

  private async handleWorkerDeliveryFailure(
    routing: { threadId: string; turnId: string; executionId: string; deliveryAttempt: number },
    error: Error,
  ): Promise<void> {
    const active = this.workerTurns.get(routing.threadId);
    if (!active || active.execution.turnId !== routing.turnId
      || active.execution.executionId !== routing.executionId
      || active.deliveryAttempt !== routing.deliveryAttempt || active.deliveryFailureHandling) return;
    // Stop intentionally closes this exact route before the provider's final callbacks settle.
    if ((active.stopInProgress || active.stopRequested) && isRetiredWorkerDelivery(error)) return;
    active.deliveryFailed = true;
    const handling = this.failWorkerDelivery(active, error);
    active.deliveryFailureHandling = handling;
    try { await handling; }
    finally { if (active.deliveryFailureHandling === handling) active.deliveryFailureHandling = undefined; }
  }

  private async failWorkerDelivery(active: WorkerOwnedTurn, error: Error): Promise<void> {
    const { execution, deliveryAttempt } = active;
    logger.error("Worker-owned canonical delivery failed", { threadId: execution.threadId,
      executionId: execution.executionId, deliveryAttempt, error: error.message });
    try {
      await this.failWorkerDispatch(active, error);
    } catch (failure) {
      logger.error("Worker-owned canonical delivery recovery failed", { threadId: execution.threadId,
        executionId: execution.executionId, error: failure instanceof Error ? failure.message : String(failure) });
      await this.requireWorkerRuntime().recoverRejected(active.execution);
    }
  }

  /** Terminalize setup failures while preserving an explicit user-stop winner. */
  private async failPreparedTurnDispatch(prepared: PreparedTurnDispatch, error: unknown): Promise<void> {
    const stopping = this.stopOperationsByThread.get(prepared.lease.threadId);
    if (stopping && this.turnGenerations.get(prepared.lease.threadId) === prepared.lease.generation) {
      // Stop owns finalization even while its terminal write is still pending.
      await stopping;
    }
    const runtime = this.turnRuntime.snapshot(prepared.lease.threadId);
    const cancelled = runtime?.turnExecutionId === prepared.lease.turnExecutionId
      && runtime.phase === "cancelled"
      && !this.mutationReservations.owns(prepared.lease.threadId, prepared.lease.mutationReservationToken, "activeTurn");
    if (cancelled) {
      await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
      this.releaseTurnAdmission(prepared.lease);
      return;
    }
    return this.failWorkerPreparedDispatch(prepared, error);
  }

  private async failWorkerPreparedDispatch(prepared: PreparedTurnDispatch, error: unknown): Promise<never> {
    if (this.turnRetryDispatchByThread.get(prepared.lease.threadId)?.dispatchStarted) throw error;
    await this.finishUnsentWorkerTurn(prepared.lease.threadId, prepared.lease.turnExecutionId);
    this.turnRuntime.terminalize(prepared.lease.threadId, prepared.lease.turnExecutionId, "errored");
    this.disarmTurnRetryWindow(prepared.lease.threadId);
    this.trackSessionEnded(prepared.lease.threadId, prepared.lease.turnExecutionId);
    this.releaseTurnAdmission(prepared.lease);
    await this.turnAdmissions.rollbackCommandEffect(prepared.commandEffect);
    throw error;
  }

  /** Finish a committed parent start that never reached provider dispatch. */
  private async finishUnsentWorkerTurn(
    threadId: string,
    executionId: string,
    terminal: UnsentWorkerTerminal = { outcome: "errored" },
  ): Promise<boolean> {
    const worker = this.workerRuntime;
    const owned = worker?.owner.current(threadId);
    if (!worker || !owned?.started || owned.execution.executionId !== executionId) return false;
    const active = this.workerTurns.get(threadId);
    const execution = owned.execution;
    const result = await this.submitUnsentWorkerFinish(worker, execution, active, terminal);
    if (!result) return true;
    if (!isAcceptedWorkerResult(result)) throw new Error("Unsent worker turn did not reach terminal acceptance");
    this.publishWorkerPersistence(active, result);
    await worker.providerEvents.retire(execution);
    await worker.owner.release(execution);
    if (active) this.requireWorkerFiles().retire(execution.threadId, execution.executionId, active.deliveryAttempt);
    this.workerTurns.delete(execution.threadId);
    return true;
  }

  private async submitUnsentWorkerFinish(
    worker: WorkerOwnedTurnRuntime,
    execution: ExecutionIdentity,
    active: WorkerOwnedTurn | undefined,
    terminal: UnsentWorkerTerminal,
  ): Promise<ExecutionWorkerResult | null> {
    try {
      return await worker.owner.submit(execution, this.unsentFinishCommand(execution, active, terminal));
    } catch (error) {
      await worker.recoverRejected(execution);
      logger.error("Unsent worker turn recovered after rejected finish", { threadId: execution.threadId,
        error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private unsentFinishCommand(
    execution: ExecutionIdentity,
    active: WorkerOwnedTurn | undefined,
    terminal: UnsentWorkerTerminal,
  ): Extract<ExecutionWorkCommand, { kind: "finish-from-state" }> {
    const { outcome } = terminal;
    const frozen = this.unsentFileEvidence(execution, active, outcome);
    const providerId = active?.prepared.providerId
      ?? this.runtimePersistence.load(execution.threadId)?.provider ?? "codex";
    return {
      kind: "finish-from-state", outcome,
      input: { ...execution, providerId,
      providerIdentities: active?.prepared.parentStartInput.providerIdentities ?? [],
      outcome, projection: { kind: "writer-staged" },
      ...unsentTerminalFields(terminal, providerId),
      ...(active ? { deliveryAttempt: active.deliveryAttempt } : {}) },
      ...(frozen ? { frozenFileEvidence: frozen } : {}),
    };
  }

  private unsentFileEvidence(
    execution: ExecutionIdentity,
    active: WorkerOwnedTurn | undefined,
    outcome: "errored" | "cancelled",
  ): ReturnType<ExecutionFileEvidenceCoordinator["seal"]> {
    return active ? this.requireWorkerFiles().seal({ ...execution,
      deliveryAttempt: active.deliveryAttempt, outcome }) : null;
  }

  /** Start a prepared first-turn command and report whether a provider turn admitted it. */
  private async sendInitialMessageAndSnapshot(
    command: SendMessageCommand,
    onError: (error: unknown) => Promise<void>,
    canReserve?: () => boolean,
  ): Promise<{ runtimeSnapshot: TurnRuntimeSnapshot; providerAdmitted: boolean; failed: boolean }> {
    let providerAdmitted = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const send = this.sendMessage({
      ...command,
      onTurnStarted: () => {
        if (command.planImplement) return;
        providerAdmitted = true;
        resolveStarted();
      },
      onAdmissionComplete: (turnAdmitted) => {
        command.onAdmissionComplete?.(turnAdmitted);
        if (!command.planImplement) return;
        providerAdmitted = turnAdmitted;
        resolveStarted();
      },
    }, canReserve);
    const outcome = await Promise.race([
      started.then(() => "started" as const),
      send.then(
        () => "finished" as const,
        async (error) => {
          await onError(error);
          return "failed" as const;
        },
      ),
    ]);
    return {
      runtimeSnapshot: this.turnRuntime.snapshot(command.threadId) ?? {
        threadId: command.threadId,
        turnExecutionId: null,
        phase: "idle",
      },
      providerAdmitted,
      failed: outcome === "failed",
    };
  }

  /**
   * Stop exact active turn. Provider teardown is detached so a slow or wedged
   * provider cannot hold the RPC; `stopProviderBounded` still bounds the settle
   * and evicts the pooled session in the background.
   */
  private async stopSessionInternal(threadId: string, stop: TurnStopCause): Promise<AgentStopResult> {
    const prepared = this.prepareStop(threadId, stop);
    const owned = this.workerRuntime?.owner.current(threadId);
    if (owned?.started && owned.execution.executionId === prepared.runtime.turnExecutionId) {
      return this.stopWorkerSession(prepared);
    }
    if (!isRunningRuntime(prepared.runtime)) return this.alreadyTerminal(prepared);
    void this.stopProviderForTurn(prepared).catch((error: unknown) => {
      logger.warn("Provider teardown failed after user stop", {
        threadId: prepared.threadId,
        providerId: prepared.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.finalizeStoppedTurn(prepared);
  }

  private async stopWorkerSession(prepared: PreparedStop): Promise<AgentStopResult> {
    const executionId = prepared.runtime.turnExecutionId!;
    const active = this.workerTurns.get(prepared.threadId);
    if (!active || !this.turnRetryDispatchByThread.get(prepared.threadId)?.dispatchStarted) {
      await this.finishUnsentWorkerTurn(prepared.threadId, executionId, { outcome: "cancelled", stop: prepared.stop });
      this.turnRuntime.terminalize(prepared.threadId, executionId, "cancelled");
      this.trackSessionEnded(prepared.threadId, executionId);
      this.disarmTurnRetryWindow(prepared.threadId);
      return this.cancelledWorkerStop(prepared);
    }
    if (!isRunningRuntime(prepared.runtime)) {
      await this.releaseWorkerTurn(active);
      return this.alreadyTerminal(prepared);
    }
    if (active.deliveryFailureHandling) {
      await active.deliveryFailureHandling;
      return this.alreadyTerminal({ ...prepared,
        runtime: this.turnRuntime.snapshot(prepared.threadId) ?? prepared.runtime });
    }
    active.stopInProgress = true;
    this.requireWorkerFiles().fence(prepared.threadId, executionId, active.deliveryAttempt);
    const drained = this.fenceWorkerProvider(active.provider, active.execution, active.deliveryAttempt, true);
    void this.stopWorkerProvider(prepared, active.provider);
    try {
      return await this.completeWorkerStop(prepared, active, drained);
    } catch (error) {
      await this.requireWorkerRuntime().recoverRejected(active.execution);
      throw error;
    } finally {
      active.stopInProgress = false;
    }
  }

  private async completeWorkerStop(
    prepared: PreparedStop,
    active: WorkerOwnedTurn,
    drained: Promise<void>,
  ): Promise<AgentStopResult> {
    await drained;
    if (active.terminalCommitted) {
      active.stopInProgress = false;
      await this.releaseWorkerTurn(active);
      return this.alreadyTerminal(prepared);
    }
    if (!active.stopRequested) {
      const stopped = await this.requireWorkerRuntime().owner.stop(active.execution, NodeCrypto.randomUUID());
      if (stopped.kind !== "committed" && stopped.kind !== "accepted") throw new Error("Worker stop request did not commit");
      active.stopRequested = true;
    }
    const frozen = this.requireWorkerFiles().seal({ ...active.execution,
      deliveryAttempt: active.deliveryAttempt, outcome: "cancelled" });
    if (!frozen) throw new Error("Worker stop lost its file evidence generation");
    await this.finishWorkerStop(active, frozen, prepared.stop);
    return this.cancelledWorkerStop(prepared);
  }

  private async finishWorkerStop(
    active: WorkerOwnedTurn,
    frozen: NonNullable<ReturnType<ExecutionFileEvidenceCoordinator["seal"]>>,
    stop: TurnStopCause,
  ): Promise<void> {
    const result = await this.requireWorkerRuntime().owner.submit(active.execution, {
      kind: "finish-from-state", outcome: "cancelled", frozenFileEvidence: frozen,
      input: { ...active.execution, providerId: active.prepared.providerId,
        providerIdentities: active.prepared.parentStartInput.providerIdentities,
        outcome: "cancelled", ending: { stop }, deliveryAttempt: active.deliveryAttempt,
        projection: { kind: "writer-staged" } },
    });
    if (result.kind !== "committed" && result.kind !== "accepted") throw new Error("Worker stop terminal did not commit");
    this.publishWorkerPersistence(active, result);
    active.terminalCommitted = true;
    active.terminalOutcome = "cancelled";
    this.turnRuntime.terminalize(active.execution.threadId, active.execution.executionId, "cancelled");
    active.stopInProgress = false;
    await this.releaseWorkerTurn(active);
  }

  private cancelledWorkerStop(prepared: PreparedStop): AgentStopResult {
    return { threadId: prepared.threadId, turnExecutionId: prepared.runtime.turnExecutionId,
      snapshot: this.turnRuntime.snapshot(prepared.threadId) ?? prepared.runtime,
      status: "cancelled", dispatchState: prepared.dispatchState };
  }

  private async stopWorkerProvider(prepared: PreparedStop, provider: IAgentProvider): Promise<void> {
    void Promise.resolve(this.featureEffects.stopDescendants(prepared.threadId)).catch((error: unknown) => {
      logger.warn("Worker-owned descendant stop failed", { threadId: prepared.threadId,
        error: error instanceof Error ? error.message : String(error) });
    });
    const stop = Promise.resolve(provider.stopSession(prepared.sessionId));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        stop.then(() => false),
        new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), PROVIDER_STOP_SETTLE_TIMEOUT_MS); }),
      ]);
      if (timedOut) this.evictUnresponsiveSession(prepared);
    } catch (error) {
      this.evictUnresponsiveSession(prepared);
      logger.warn("Worker-owned provider stop failed", { threadId: prepared.threadId,
        error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  private prepareStop(threadId: string, stop: TurnStopCause): PreparedStop {
    const reservationToken = this.activeMutationReservations.get(threadId);
    const runtime = this.turnRuntime.snapshot(threadId) ?? idleRuntime(threadId);
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    const reservation = reservationToken ? this.mutationReservations.get(threadId) : undefined;
    const dispatchState = stopDispatchState(runtime, dispatch?.dispatchStarted, reservation?.state);
    if (reservationToken) this.mutationReservations.transition(threadId, reservationToken, "activeTurn", "stopping");
    return {
      threadId,
      sessionId: `mcode-${threadId}`,
      providerId: this.activeProviderId(threadId),
      reservationToken,
      dispatchState,
      runtime,
      stop,
    };
  }

  private async stopProviderForTurn(prepared: PreparedStop): Promise<void> {
    await this.featureEffects.stopDescendants(prepared.threadId);
    if (prepared.dispatchState !== "not-dispatched") await this.stopProviderBounded(prepared);
    this.disarmTurnRetryWindow(prepared.threadId);
  }

  /**
   * Bound provider cancellation so a wedged provider cannot pin the turn in
   * "stopping" forever, which would suppress every later terminal event.
   */
  private async stopProviderBounded(prepared: PreparedStop): Promise<void> {
    const attempt = this.stopProvider(prepared);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        attempt.then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), PROVIDER_STOP_SETTLE_TIMEOUT_MS);
        }),
      ]);
      if (!timedOut) return;
      logger.warn("Provider stopSession did not settle; finalizing turn as cancelled", {
        threadId: prepared.threadId,
        providerId: prepared.providerId,
        sessionId: prepared.sessionId,
        timeoutMs: PROVIDER_STOP_SETTLE_TIMEOUT_MS,
      });
      // Observe the wedged promise so a late rejection cannot crash the process.
      void attempt.catch((error: unknown) => {
        logger.warn("Provider stopSession rejected after timeout", {
          threadId: prepared.threadId,
          providerId: prepared.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.evictUnresponsiveSession(prepared);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop a pooled session whose provider ignored cancellation so the next turn respawns fresh. */
  private evictUnresponsiveSession(prepared: PreparedStop): void {
    const providerId = prepared.providerId;
    if (!providerId) return;
    if (this.turnRuntime.snapshot(prepared.threadId)?.turnExecutionId !== prepared.runtime.turnExecutionId) return;
    void (async () => {
      const provider = this.providerRegistry.resolve(providerId);
      await this.evictPooledSession(provider, prepared.sessionId);
    })().catch((error: unknown) => {
      logger.warn("Failed to evict unresponsive provider session", {
        threadId: prepared.threadId,
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async stopProvider(prepared: PreparedStop): Promise<void> {
    if (!prepared.providerId) return;
    try {
      await this.providerRegistry.resolve(prepared.providerId).stopSession(prepared.sessionId);
    } catch (error) {
      const current = this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId);
      // Detached teardown belongs to the stopped execution, never a newer turn.
      if (current.turnExecutionId !== prepared.runtime.turnExecutionId) return;
      if (!isRunningRuntime(current)) {
        // The turn already finalized as cancelled; a session that failed
        // teardown is untrusted, so evict it rather than reuse it.
        if (current.phase === "cancelled") this.evictUnresponsiveSession(prepared);
        return;
      }
      if (prepared.reservationToken) {
        this.mutationReservations.transition(prepared.threadId, prepared.reservationToken, "stopping", "activeTurn");
      }
      this.retryingThreads.delete(prepared.threadId);
      this.endedSuppressionThreads.delete(prepared.threadId);
      logger.warn("Provider stopSession failed", { threadId: prepared.threadId, providerId: prepared.providerId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async finalizeStoppedTurn(prepared: PreparedStop): Promise<AgentStopResult> {
    const current = this.turnRuntime.snapshot(prepared.threadId) ?? prepared.runtime;
    if (!ownsStoppedExecution(current, prepared.runtime.turnExecutionId)) return this.alreadyTerminal({ ...prepared, runtime: current });
    if (!this.turnRuntime.terminalize(prepared.threadId, prepared.runtime.turnExecutionId!, "cancelled")) {
      return this.alreadyTerminal({ ...prepared, runtime: this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId) });
    }
    this.disarmTurnRetryWindow(prepared.threadId);
    this.clearTurnEndedState(prepared.threadId);
    await this.runtimePersistence.recordTurnOutcome(prepared.threadId, "cancelled");
    await this.runtimePersistence.setRuntimeStatus(prepared.threadId, "paused");
    broadcast("thread.status", { threadId: prepared.threadId, status: "paused" });
    this.trackSessionEnded(prepared.threadId, prepared.runtime.turnExecutionId);
    return {
      threadId: prepared.threadId,
      turnExecutionId: prepared.runtime.turnExecutionId,
      snapshot: this.turnRuntime.snapshot(prepared.threadId) ?? idleRuntime(prepared.threadId),
      status: "cancelled",
      dispatchState: prepared.dispatchState,
    };
  }

  private alreadyTerminal(prepared: PreparedStop): AgentStopResult {
    this.disarmTurnRetryWindow(prepared.threadId);
    return {
      threadId: prepared.threadId,
      turnExecutionId: prepared.runtime.turnExecutionId,
      snapshot: prepared.runtime,
      status: "already-terminal",
      dispatchState: prepared.dispatchState,
    };
  }

  /** Number of currently active sessions. */
  private activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Atomically reserve the first accepted send for one thread. */
  private reserveTurn(threadId: string): boolean {
    if (this.activeSessionIds.has(threadId)) return false;
    this.activeSessionIds.add(threadId);
    return true;
  }

  /** Get all currently active thread IDs. */
  private activeThreadIds(): string[] {
    return this.turnRuntime.runningThreadIds();
  }

  /** Return authoritative per-thread runtime snapshots for reconnect hydration. */
  private runtimeSnapshots(): TurnRuntimeSnapshot[] {
    return this.turnRuntime.snapshots().map((snapshot) => ({
      ...snapshot,
      savingStatuses: [...this.workerRuntime?.progress?.savingStatuses(snapshot.threadId) ?? []],
    }));
  }

  /** Normalize one provider event once at the production provider boundary. */
  normalize(event: AgentEvent): AgentEvent | undefined {
    const normalized = this.turnRuntime.normalizeEvent(event);
    if (!normalized) this.warnDroppedTerminal(event);
    return normalized;
  }

  /** Surface a terminal event normalization dropped while its turn still runs. */
  private warnDroppedTerminal(event: AgentEvent): void {
    const terminal = event.type === AgentEventType.TurnComplete
      || event.type === AgentEventType.Error
      || (event.type === AgentEventType.Ended && event.outcome !== undefined);
    if (!terminal) return;
    const snapshot = this.turnRuntime.snapshot(event.threadId);
    if (!snapshot || !isRunningRuntime(snapshot)) return;
    logger.warn("Terminal provider event dropped for a still-running turn", {
      threadId: event.threadId,
      type: event.type,
      eventExecutionId: event.turnExecutionId ?? null,
      runtimeExecutionId: snapshot.turnExecutionId,
      runtimePhase: snapshot.phase,
    });
  }

  /**
   * Track that a session has ended. No-ops if the session was not active.
   * If this was the last active session, signals idle to MemoryPressureService.
   */
  private trackSessionEnded(threadId: string, executionId?: string | null): void {
    if (this.activeSessionIds.delete(threadId)) {
      this.memoryPressureService.markIdle(threadId);
    }
    if (executionId) {
      const resolve = this.runtimeReleaseCallbacks.get(executionId);
      if (resolve) {
        this.runtimeReleaseCallbacks.delete(executionId);
        resolve();
      }
    }
    const reservationToken = this.turnRetryDispatchByThread.get(threadId)?.mutationReservationToken;
    this.releaseMutationReservation(threadId, reservationToken);
    for (const listener of this.runtimeReleaseListeners) listener(threadId);
  }

  /** Clear resources that belong to a turn after terminal handling owns the outcome. */
  private clearTurnEndedState(threadId: string): void {
    this.threadControlMcp?.revoke(`mcode-${threadId}`);
    this.scopedPreGrant.clear(threadId);
    this.featureEffects.clearTurn(threadId);
  }

  /** Release the shared mutation token without forcing provider-session teardown. */
  private releaseMutationReservation(threadId: string, reservationToken?: string): void {
    const currentToken = this.activeMutationReservations.get(threadId);
    const token = reservationToken ?? currentToken;
    if (token && currentToken === token) {
      this.activeMutationReservations.delete(threadId);
      this.mutationReservations.release(threadId, token);
    }
  }

  /** Check exact runtime and reservation ownership before setup crosses an async boundary. */
  private ownsActiveTurnExecution(
    threadId: string,
    turnExecutionId: string,
    reservationToken: string,
  ): boolean {
    const runtime = this.turnRuntime.snapshot(threadId);
    return runtime?.turnExecutionId === turnExecutionId
      && (runtime.phase === "running" || runtime.phase === "finalizing")
      && this.mutationReservations.owns(threadId, reservationToken, "activeTurn");
  }

  /** Return a retry dispatch only while its token and generation still own the thread. */
  private getCurrentRetryDispatch(
    threadId: string,
    identity?: RetryDispatchIdentity,
  ): (typeof this.turnRetryDispatchByThread extends Map<string, infer T> ? T : never) | null {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (!dispatch) return null;
    if (identity
      && (dispatch.mutationReservationToken !== identity.mutationReservationToken
        || dispatch.generation !== identity.generation)) {
      return null;
    }
    if (!this.mutationReservations.owns(threadId, dispatch.mutationReservationToken, "activeTurn")) {
      return null;
    }
    return dispatch;
  }

  /** Snapshot the identity used to fence delayed retry work from a replacement turn. */
  private retryDispatchIdentity(dispatch: {
    mutationReservationToken: string;
    generation: number;
  }): RetryDispatchIdentity {
    return {
      mutationReservationToken: dispatch.mutationReservationToken,
      generation: dispatch.generation,
    };
  }

  /**
   * Whether a provider-emitted `Error` for `threadId` should be hidden from the
   * UI because a transient-failure retry is in flight. True only when the thread
   * is armed (mid retry loop) AND the error itself classifies as transient, so a
   * fatal error always reaches the user even during the retry window. Consulted
   * by the composition root before broadcasting and by the errored-finalize path.
   */
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean {
    return this.retryingThreads.has(threadId) && this.turnErrorPolicy.classify(errorMessage) === "transient";
  }

  /**
   * Whether a provider-emitted `Ended` for `threadId` should be swallowed because
   * it trails a just-suppressed transient `Error` or an explicit user stop. Keeps
   * a failed attempt's teardown from flashing before retry, and keeps a provider
   * stop's synchronous teardown event from terminalizing the turn as interrupted
   * before stopSession can durably record cancelled. Consulted by the composition
   * root before broadcasting and by the `Ended` cleanup path.
   */
  shouldSuppressTurnEnded(threadId: string): boolean {
    if (this.endedSuppressionThreads.has(threadId)) return true;
    if (this.mutationReservations.get(threadId)?.state === "stopping") return true;
    // Swallow `Ended` emitted while a re-dispatch is mid-flight (e.g. the pooled
    // session's eviction `Ended` during a transient retry).
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    return dispatch?.retryInFlight === true;
  }

  /**
   * Whether a provider-emitted `TurnComplete` for `threadId` should be swallowed
   * because it belongs to a failed attempt that is being retried. Mirrors
   * {@link shouldSuppressTurnEnded}: both gate the same retry-window teardown.
   */
  shouldSuppressTurnComplete(threadId: string): boolean {
    return this.endedSuppressionThreads.has(threadId);
  }

  /**
   * Clears the transient-retry window once the turn has finished or given up.
   */
  private disarmTurnRetryWindow(
    threadId: string,
    identity?: RetryDispatchIdentity,
    preserveCommandEffect = false,
  ): boolean {
    const dispatch = this.turnRetryDispatchByThread.get(threadId);
    if (identity && (!dispatch
      || dispatch.mutationReservationToken !== identity.mutationReservationToken
      || dispatch.generation !== identity.generation)) {
      return false;
    }
    this.retryingThreads.delete(threadId);
    this.endedSuppressionThreads.delete(threadId);
    this.turnRetryDispatchByThread.delete(threadId);
    if (!preserveCommandEffect) this.turnAdmissions.completeCommandEffect(dispatch?.commandEffect ?? null);
    return true;
  }

  /**
   * Evicts a pooled provider session and waits for its subprocess to unwind so
   * any trailing `Ended` from teardown is emitted while suppression is still armed.
   */
  private async evictPooledSession(
    provider: import("@mcode/contracts/providers/interfaces").IAgentProvider,
    sessionName: string,
  ): Promise<void> {
    if (!isSessionEvictable(provider)) return;
    await provider.discardSession(sessionName);
    const withWait = provider as import("@mcode/contracts/providers/interfaces").IAgentProvider & {
      waitForSessionExit?: (sessionId: string, timeoutMs?: number) => Promise<void>;
    };
    if (typeof withWait.waitForSessionExit === "function") {
      await withWait.waitForSessionExit(sessionName, 5000);
    }
  }

  /** Subscribe to provider ingress after the service has assembled its event pipeline. */
  private initializeProviderEvents(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.memoryPressureService.onPressureChange((snapshot) => {
      this.handleMemoryPressure(snapshot);
    });

    this.providerEventIngress.start(this.providerRegistry, this.turnEventPipeline);
    for (const provider of this.providerRegistry.resolveAll()) {
      if (!isCopilotBoundary(provider)) continue;
      provider.setCanonicalTurnDeliveryFailureHandler(async (routing, error) => {
        return this.handleWorkerDeliveryFailure(routing, error);
      });
    }
  }

  private handleMemoryPressure(snapshot: MemoryPressureSnapshot): void {
    const truncateOutput = snapshot.level !== "normal";
    for (const provider of this.providerRegistry.resolveAll()) {
      const memoryAware = provider as IAgentProvider & {
        setOutputTruncationMode?: (enabled: boolean) => void;
        shedMemoryPressure?: (level: MemoryPressureSnapshot["level"], isThreadProtected: (threadId: string) => boolean) => Promise<void> | void;
      };

      memoryAware.setOutputTruncationMode?.(truncateOutput);
      if (snapshot.level === "normal" || typeof memoryAware.shedMemoryPressure !== "function") {
        continue;
      }
      Promise.resolve(memoryAware.shedMemoryPressure(snapshot.level, (threadId) => this.activeSessionIds.has(threadId))).catch((err: unknown) => {
        logger.warn("Provider memory-pressure shedding failed", {
          level: snapshot.level,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Admit a complete turn command, then retain only runtime-owned provider dispatch.
   */
  async sendMessage(command: SendMessageCommand, canReserve?: () => boolean): Promise<void> {
    await this.awaitEndedTurnRelease(command.threadId);
    const admitted = await this.turnAdmissions.admit(command, this.runtimeAdmissionAuthority(), canReserve);
    if (admitted.kind !== "dispatch") return;
    await this.dispatchPreparedTurn(admitted);
  }

  /**
   * Admit a turn the provider started by itself, such as Claude replying to a
   * finished background task. It runs the user-turn admission pipeline with
   * `notice` as the opening line, binds the worker route, and returns the
   * server-minted routing; the provider is already running the turn, so nothing
   * is dispatched to it.
   */
  async openProviderTurn(request: { threadId: string; notice: string }): Promise<ProviderTurnOpening> {
    await this.awaitEndedTurnRelease(request.threadId);
    const declined = this.declineProviderTurn(request.threadId);
    if (declined) return declined;
    let admitted: Awaited<ReturnType<TurnAdmissionDispatchCoordinator["admit"]>>;
    try {
      admitted = await this.turnAdmissions.admit({
        threadId: request.threadId,
        content: request.notice,
        providerOriginated: true,
        permissionMode: "default",
      }, this.runtimeAdmissionAuthority());
    } catch (error) {
      return this.providerTurnAdmissionFailure(request.threadId, error);
    }
    if (admitted.kind !== "dispatch") return { kind: "declined", reason: "unavailable" };
    try {
      await this.prepareRuntimeDispatch(admitted);
      await this.activatePreparedCommandEffect(admitted);
      this.adoptPreparedProviderDispatch(admitted);
    } catch (error) {
      await this.failPreparedTurnDispatch(admitted, error);
      return { kind: "declined", reason: "unavailable" };
    }
    return { kind: "opened", routing: {
      threadId: admitted.lease.threadId, turnId: admitted.request.turnId,
      executionId: admitted.lease.turnExecutionId, deliveryAttempt: 1,
    } };
  }

  /**
   * A provider can start a turn as soon as its previous one ends, before the server has
   * released that turn. Its committed Ended already frees the thread, so wait for the release
   * instead of declining as busy. A failed release is logged where it runs; admission then reports the thread as held.
   */
  private async awaitEndedTurnRelease(threadId: string): Promise<void> {
    const active = this.workerTurns.get(threadId);
    if (!active?.terminalCommitted) return;
    await active.terminalRelease?.catch(() => undefined);
  }

  /** Refuse provider turns while the user is stopping the thread, and stop the session as the legacy path did. */
  private declineProviderTurn(threadId: string): Extract<ProviderTurnOpening, { kind: "declined" }> | null {
    const thread = this.runtimePersistence.load(threadId);
    if (!thread) return { kind: "declined", reason: "unavailable" };
    if (this.mutationReservations.get(threadId)?.state !== "stopping") return null;
    this.stopUnadmittedTurn(threadId, this.activeProviderId(threadId), "provider turn while stopping");
    return { kind: "declined", reason: "stopping" };
  }

  /** Map an admission refusal to the decline the provider acts on; a terminal thread also stops the session. */
  private providerTurnAdmissionFailure(threadId: string, error: unknown): Extract<ProviderTurnOpening, { kind: "declined" }> {
    const message = error instanceof Error ? error.message : String(error);
    if (/already has an active agent session|already has a pending mutation/.test(message)) return { kind: "declined", reason: "busy" };
    if (/Cannot send message to (terminal|deleted) thread/.test(message)) {
      this.stopUnadmittedTurn(threadId, this.activeProviderId(threadId), "provider turn on stopped thread");
      return { kind: "declined", reason: "stopped" };
    }
    logger.warn("Provider turn admission failed", { threadId, error: message });
    return { kind: "declined", reason: "unavailable" };
  }

  /** Record an adopted turn's dispatch state without sending a prompt the provider never received. */
  private adoptPreparedProviderDispatch(prepared: PreparedTurnDispatch): void {
    this.applyThreadControlLease(prepared.threadControl);
    const dispatch = this.createRetryDispatch(prepared);
    dispatch.dispatchStarted = true;
    this.turnRetryDispatchByThread.set(prepared.lease.threadId, dispatch);
    this.bindClaudeCanonicalDelivery(prepared.provider);
    logger.info("Provider-started turn admitted", { threadId: prepared.lease.threadId, executionId: prepared.lease.turnExecutionId });
  }

  /** Provision a thread through its coordinator, then start its generic first-turn command. */
  async createAndSend(command: CreateAndSendCommand, options?: CreateAndSendOptions): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[]; queued?: boolean }> {
    const created = await this.threadCreation.createInitialTurn(command, options);
    if (created.kind === "replay") {
      return {
        ...created.thread,
        runtimeSnapshot: this.turnRuntime.snapshot(created.thread.id) ?? idleRuntime(created.thread.id),
      };
    }
    if (created.kind === "queued") {
      return {
        ...created.thread,
        queued: true,
        runtimeSnapshot: { threadId: created.thread.id, turnExecutionId: null, phase: "idle" },
        ...(created.thread.warnings?.length ? { warnings: created.thread.warnings } : {}),
      };
    }
    return this.dispatchInitialTurn(created);
  }

  private async dispatchInitialTurn(
    created: Extract<CreatedInitialTurn, { kind: "dispatch" }>,
  ): Promise<Thread & { runtimeSnapshot: TurnRuntimeSnapshot; warnings?: string[] }> {
    let runtimeSnapshot: TurnRuntimeSnapshot;
    try {
      await this.threadCreation.startInitialAgent(created.startupId);
      const initialDispatch = await this.sendInitialMessageAndSnapshot(created.command, async (err) => {
        logger.error("createAndSend initial send failed", {
          threadId: created.thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.threadCreation.failInitialAgent(created.startupId);
      }, () => this.threadCreation.canAdmitQueuedAgent(created.thread.id, created.startupId));
      runtimeSnapshot = initialDispatch.runtimeSnapshot;
      // A provider turn finishes the startup through StartupAgentPhaseObserver once the provider answers. A command
      // handled without a provider turn has nothing to wait for, so it finishes the startup here.
      if (!initialDispatch.failed && !initialDispatch.providerAdmitted
        && !await this.threadCreation.settleVetoedAgent(created.startupId)
        && this.threadCreation.canAdmitQueuedAgent(created.thread.id, created.startupId)) {
        await this.threadCreation.completeHandledInitialCommand(created.startupId);
      }
    } catch (error) {
      await this.threadCreation.failInitialAgent(created.startupId);
      throw error;
    }
    return {
      ...created.thread,
      runtimeSnapshot,
      ...(created.thread.warnings?.length ? { warnings: created.thread.warnings } : {}),
    };
  }

  /** Dispatch a queued Turn that the automatic Setup lifecycle claimed after commit. */
  async dispatchQueuedAutomaticTurn(
    submission: WorkspaceEnvironmentQueuedTurnSubmission,
  ): Promise<WorkspaceEnvironmentAutomaticSetupDispatch> {
    const startupId = await this.threadCreation.startQueuedAgent(submission.threadId);
    if (startupId === null) return { completion: Promise.resolve() };
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let cancellationWon = false;
    const send = this.sendMessage({
      ...this.turnAdmissions.queuedCommand(submission),
      onTurnStarted: () => {
        if (!submission.planImplement) resolveStarted();
      },
      onAdmissionComplete: () => {
        if (submission.planImplement) resolveStarted();
      },
      onRuntimeReleased: resolveCompletion,
    }, () => {
      const canReserve = this.threadCreation.canAdmitQueuedAgent(submission.threadId, startupId);
      cancellationWon ||= !canReserve;
      return canReserve;
    });
    try {
      await Promise.race([
        started,
        send.then(() => {
          if (cancellationWon) return;
          throw new Error(`Queued Turn finished without runtime dispatch: ${submission.threadId}`);
        }),
      ]);
    } catch (error) {
      await this.threadCreation.failInitialAgent(startupId);
      throw error;
    }
    if (cancellationWon) {
      await this.threadCreation.settleVetoedAgent(startupId);
      return { completion: Promise.resolve() };
    }
    return { completion };
  }

  /**
   * Stop exact active turn, sharing one in-flight operation per thread.
   * A concurrent caller joins the in-flight operation, so the first caller's stop cause is the one recorded.
   */
  async stopSession(threadId: string, stop: TurnStopCause): Promise<AgentStopResult> {
    const existing = this.stopOperationsByThread.get(threadId);
    if (existing) return existing;
    const operation = this.stopSessionInternal(threadId, stop);
    this.stopOperationsByThread.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.stopOperationsByThread.get(threadId) === operation) {
        this.stopOperationsByThread.delete(threadId);
      }
    }
  }

  /** Stop the active turn and discard any pooled provider session for a deleted thread. */
  async teardownSession(threadId: string): Promise<void> {
    const sessionId = `mcode-${threadId}`;
    const providerId = this.activeProviderId(threadId);
    const wasActive = this.activeSessionIds.has(threadId);

    if (wasActive) {
      await this.stopSession(threadId, { by: "mcode", reason: "thread_deleted" });
    }

    if (!providerId) return;
    let provider: import("@mcode/contracts/providers/interfaces").IAgentProvider;
    try {
      provider = this.providerRegistry.resolve(providerId);
    } catch (err) {
      logger.warn("Provider unavailable during thread teardown", {
        threadId,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (isSessionEvictable(provider)) {
      await this.evictPooledSession(provider, sessionId);
    } else if (!wasActive) {
      await Promise.race([
        Promise.resolve(provider.stopSession(sessionId)).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_STOP_SETTLE_TIMEOUT_MS)),
      ]);
    }
  }

  /** Return narrow runtime capabilities for server-owned diagnostics and recovery infrastructure. */
  runtimeAccess(): AgentRuntimeAccess {
    return {
      activeCount: () => this.activeCount(),
      activeThreadIds: () => this.activeThreadIds(),
      runtimeSnapshots: () => this.runtimeSnapshots(),
    };
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const ids = [...this.activeSessionIds];
    await Promise.all(
      ids.map(async (threadId) => {
        await this.featureEffects.stopDescendants(threadId);
        const sessionId = `mcode-${threadId}`;
        const providerId = this.activeProviderId(threadId);
        if (!providerId) return;
        try {
          const provider = this.providerRegistry.resolve(providerId);
          await Promise.race([
            Promise.resolve(provider.stopSession(sessionId)).catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_STOP_SETTLE_TIMEOUT_MS)),
          ]);
        } catch {
          // best-effort
        }
      }),
    );
    this.activeSessionIds.clear();
    for (const [threadId, token] of this.activeMutationReservations) {
      this.mutationReservations.release(threadId, token);
    }
    this.activeMutationReservations.clear();
  }
}

function isAcceptedWorkerResult(result: ExecutionWorkerResult): result is Extract<ExecutionWorkerResult, { kind: "committed" | "accepted" }> {
  return result.kind === "committed" || result.kind === "accepted";
}

function hasClaudeCanonicalDelivery(provider: IAgentProvider): provider is IAgentProvider & Pick<ClaudeProviderBoundary, "setCanonicalTurnDeliveryFailureHandler"> {
  return provider.id === "claude" && "setCanonicalTurnDeliveryFailureHandler" in provider
    && typeof provider.setCanonicalTurnDeliveryFailureHandler === "function";
}

/** A plain thrown error carries no classification, so it is fatal. */
function dispatchFailure(error: unknown): TurnFailure {
  return error instanceof ProviderTurnError ? error.failure : { kind: "fatal" };
}

/** The cause a provider terminal event records, enriched once where the execution accepts it. */
function observeWorkerRetries(active: WorkerOwnedTurn, event: AgentEvent | null): void {
  if (event?.type === "apiRetry") active.lastRetries = observedProviderRetries(event) ?? active.lastRetries;
}

function workerProviderEnding(
  active: WorkerOwnedTurn,
  outcome: TurnOutcome,
  event: AgentEvent,
  interruption: TurnEndingCause,
): TurnEndingCause | undefined {
  if (event.type === "error") {
    return providerFailureTerminal(persistTurnFailure({ failure: event.failure, provider: active.prepared.providerId,
      message: event.error, acceptedAt: Date.now(), ...(active.lastRetries ? { lastRetries: active.lastRetries } : {}) })).ending;
  }
  // A user stop fences provider delivery first, so a provider-reported interruption has no user cause.
  return event.type === "ended" && outcome === "interrupted" ? interruption : undefined;
}

function unsentTerminalFields(terminal: UnsentWorkerTerminal, providerId: string): Pick<DataOnlyParentTurnFinishInput, "error" | "ending"> {
  if (terminal.outcome === "cancelled") return { ending: { stop: terminal.stop } };
  const error = "Provider turn failed before dispatch";
  return { error, ending: { failure: persistTurnFailure({ failure: { kind: "fatal" }, provider: providerId,
    message: error, acceptedAt: Date.now() }) } };
}

function workerTerminalOutcome(event: AgentEvent): TurnOutcome | null {
  if (event.type === "turnComplete") return "completed";
  if (event.type === "error") return providerFailureOutcome(event.failure);
  if (event.type !== "ended" || event.outcome === undefined) return null;
  return event.outcome === "cancelled" ? "interrupted" : event.outcome;
}

/** Keeps child events and Codex collaboration observations out of parent terminal detection. */
export function writerOwnedProviderExtension(extension: ProviderRuntimeEvent["extension"]): boolean {
  return isChildRoutedRuntimeEvent(extension) || Boolean(extension?.kind === "codex-collaboration" && extension.collaboration);
}

function matchesWorkerEvent(event: AgentEvent, batch: WorkerOwnedProviderEventBatch): boolean {
  return event.threadId === batch.threadId && event.turnExecutionId === batch.executionId;
}

function isRetiredWorkerDelivery(error: Error): boolean {
  return error.message === "Canonical event execution is no longer admitted"
    || error.message === "Provider batch belongs to a retired execution attempt"
    || error.message === "Prepared provider event lost its execution owner";
}

function isCopilotBoundary(provider: IAgentProvider): provider is CopilotProviderBoundary {
  return provider.id === "copilot" && "setCanonicalTurnDeliveryFailureHandler" in provider && typeof provider.setCanonicalTurnDeliveryFailureHandler === "function";
}
