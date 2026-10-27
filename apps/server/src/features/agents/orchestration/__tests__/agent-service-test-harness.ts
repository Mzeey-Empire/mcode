import "reflect-metadata";
import { observeWorkerPublications } from "./worker-publication-observer.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { ExecutionFileEvidenceCoordinator } from "../../execution/execution-file-evidence-coordinator.js";
import { ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { Database } from "bun:sqlite";
import { TurnRevertStore } from "../../turns/persistence/turn-revert-store.js";
import { ThreadStartupFetchDecisions } from "../../../thread-startup/thread-startup-fetch-decisions.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { agentStorageTestWriter, registerAgentStorageTestProducer } from "../../__tests__/agent-storage-fixture.js";
import { TurnDiffService } from "../../turns/turn-diff-service.js";
import { TurnDiffRepo } from "../../turns/persistence/turn-diff-repo.js";
import { container, Lifecycle } from "tsyringe";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HandoffStorage } from "../../../handoff/persistence/handoff-storage.js";
import { ThreadProviderSessionRepo } from "../../../thread-control/persistence/thread-provider-session-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ProviderSwitchService } from "../../turns/provider-switch-service.js";
import type { TurnRecoveryService } from "../../recovery/turn-recovery-service.js";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { IProviderRegistry, ProviderId } from "@mcode/contracts/providers/interfaces";
import type { ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import * as NodeEvents from "node:events";

import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { WorkspaceEnvironmentService } from "../../../projects/index.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ThreadService } from "../../../thread-control/index.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { ScopedPreGrantService } from "../../permissions/scoped-pre-grant.js";
import { SubagentRosterService } from "../../collaboration/subagent-roster-service.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { ParentTurnDurability } from "../../turns/parent-turn-durability.js";
import { PARENT_TURN_DURABILITY } from "../../turns/parent-turn-durability.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { TurnAdmissionDispatchCoordinator } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TurnConversationProjectionService } from "../../turns/turn-conversation-projection-service.js";
import { TurnFileTracker } from "../../turns/turn-file-tracker.js";
import { TurnFinalizer } from "../../turns/turn-finalizer.js";
import { ThreadRuntimePersistence, TURN_RUNTIME_PERSISTENCE } from "../../turns/turn-runtime-persistence.js";
import { TURN_FINALIZER } from "../../turns/turn-finalizer.js";
import { TURN_ADMISSION_DISPATCH_COORDINATOR } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TURN_FEATURE_EFFECTS } from "../../turns/turn-feature-effects.js";
import { McodeSessionAuthority } from "../../../mcode-mcp/index.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";
import { ThreadBranchingService } from "../../../projects/worktrees/thread-branching-service.js";
import { AgentService } from "../agent-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../agent-turn-command-port.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { AgentReliabilityPort } from "../agent-runtime-internal-ports.js";
import { TurnFeatureEffects } from "../../turns/turn-feature-effects.js";
import { AgentEventPublicationRuntimePort, AgentTurnContinuationPort } from "../agent-runtime-internal-ports.js";
import { TurnRuntimeController } from "../turn-runtime-controller.js";
import { ProviderTurnEventApplication } from "../../turns/provider-turn-event-application.js";
import { TURN_RUNTIME_EVENT_CONTROL, type TurnRuntimeEventControl } from "../turn-runtime-event-control.js";

const testPublicationObservers = new WeakMap<AgentService, (event: AgentEvent) => void>();
const testPublicationCleanup = new WeakMap<AgentService, () => void>();
const testWorkers = new WeakMap<AgentService, WorkerOwnedTurnRuntime>();
const testProviderDrains = new WeakMap<AgentService, () => Promise<void>>();
const providerRuntimePublishers = new WeakMap<NodeEvents.EventEmitter, (event: unknown) => void>();

const testEventPublications = new WeakMap<AgentService, AgentEventPublicationRegistry>();
const testReliabilityPorts = new WeakMap<AgentService, AgentReliabilityPort>();
const testContinuations = new WeakMap<AgentService, AgentTurnContinuationPort>();
const testProviderTurnStarts = new WeakMap<AgentService, (threadId: string) => Promise<string>>();
const testMessageRepos = new WeakMap<AgentService, MessageRepo>();
const testTrackers = new WeakMap<AgentService, TurnFileTracker>();
const testTurnDiffs = new WeakMap<AgentService, TurnDiffService>();
const testProviderEventIngresses = new WeakMap<AgentService, ProviderEventIngress>();
const testProviderApplications = new WeakMap<AgentService, ProviderTurnEventApplication>();
const testPersistenceDrains = new WeakMap<AgentService, Promise<void>>();

/** Read the real native evidence service wired through the test runtime and ingress. */
export function turnDiffsForAgentServiceTest(service: AgentService): TurnDiffService {
  const turnDiffs = testTurnDiffs.get(service);
  if (!turnDiffs) throw new Error("Agent service was not created by this harness");
  return turnDiffs;
}
const testGoalLifecycles = new WeakMap<AgentService, GoalLifecycleService>();

/** Wrap test provider events at the same runtime boundary as real providers. */
export function runtimeProviderEvent(event: AgentEvent): ProviderRuntimeEvent {
  return { event };
}

export function wrapProviderEmitterForRuntimeEvents<T extends NodeEvents.EventEmitter>(emitter: T): T {
  const emit = emitter.emit.bind(emitter);
  emitter.emit = (eventName: string | symbol, ...args: unknown[]): boolean => {
    if (eventName === "event") {
      const publish = providerRuntimePublishers.get(emitter);
      if (publish) {
        publish(args[0]);
        return true;
      }
    }
    return emit(eventName, ...args);
  };
  return emitter;
}

/** Start provider ingress for a test-built service without expanding its production facade. */
export function startAgentServiceIngressForTest(
  service: AgentService,
  publisher?: (event: import("@mcode/contracts/events/agent-event").AgentEvent) => void,
): void {
  const publication = testEventPublications.get(service);
  if (!publication) throw new Error("AgentService test publication is unavailable");
  if (publisher) {
    publication.bind(publisher);
    testPublicationObservers.set(service, publisher);
  }
  else if (!publication.isBound()) publication.bind(() => undefined);
  publication.start();
}

/** Resolve after the test service has applied every ingress event already accepted for a thread. */
export async function waitForAgentServiceIngressForTest(service: AgentService, threadId: string): Promise<void> {
  const ingress = testProviderEventIngresses.get(service);
  if (!ingress) throw new Error("AgentService test provider ingress is unavailable");
  await testProviderDrains.get(service)?.();
  await ingress.waitForThread(threadId);
  await testWorkers.get(service)?.progress?.waitForTerminalSaves(threadId);
}

/** Stop fixture providers and drain their admitted events and effects before their database closes. */
export function drainAgentServicePersistenceForTest(service: AgentService): Promise<void> {
  const existing = testPersistenceDrains.get(service);
  if (existing) return existing;
  const ingress = testProviderEventIngresses.get(service);
  const application = testProviderApplications.get(service);
  if (!ingress || !application) throw new Error("Agent service was not created by this harness");
  const drain = (async () => {
    try {
      await testProviderDrains.get(service)?.();
    } finally {
      try {
        await service.stopAll();
        await ingress.stopAdmissionAndDrain();
        await application.drainPersistence();
      } finally {
        try {
          await testWorkers.get(service)?.close();
        } finally {
          testPublicationCleanup.get(service)?.();
        }
      }
    }
  })();
  testPersistenceDrains.set(service, drain);
  return drain;
}

/** Stream deterministic assistant text through the test-owned reliability port. */
export function streamAgentReliabilityTextForTest(
  service: AgentService,
  threadId: string,
): Promise<{ threadId: string; executionId: string; text: string }> {
  const reliability = testReliabilityPorts.get(service);
  if (!reliability) throw new Error("AgentService test reliability port is unavailable");
  return reliability.streamAssistantText(threadId);
}

/** Continue an active turn through the existing runtime port. */
export function continueAgentTurnWithoutSavingForTest(service: AgentService, executionId: string): void {
  const continuation = testContinuations.get(service);
  if (!continuation) throw new Error("AgentService test continuation is unavailable");
  continuation.continueWithoutSaving(executionId);
}

export async function startProviderTurnForTest(service: AgentService, threadId: string): Promise<string> {
  const start = testProviderTurnStarts.get(service);
  if (!start) throw new Error("AgentService test provider-turn start is unavailable");
  return start(threadId);
}

/** Return the message persistence dependency used by the focused fixture. */
export function messageRepoForAgentServiceTest(service: AgentService): MessageRepo {
  const messages = testMessageRepos.get(service);
  if (!messages) throw new Error("AgentService test messages are unavailable");
  return messages;
}

/** Return the file tracker used by a focused runtime fixture. */
export function fileTrackerForAgentServiceTest(service: AgentService): TurnFileTracker {
  const tracker = testTrackers.get(service);
  if (!tracker) throw new Error("AgentService test file tracker is unavailable");
  return tracker;
}

/** Return the goal owner used by a focused runtime fixture. */
export function goalLifecycleForAgentServiceTest(service: AgentService): GoalLifecycleService {
  const goals = testGoalLifecycles.get(service);
  if (!goals) throw new Error("AgentService test goal lifecycle is unavailable");
  return goals;
}

/** Build AgentService feature owners for tests that use focused repository fixtures. */
export function createAgentServiceForTest(
  threadRepo: ThreadRepo,
  workspaceRepo: WorkspaceRepo,
  messageRepo: MessageRepo,
  gitWorktrees: GitWorktreeService,
  attachmentService: AttachmentService,
  providerRegistry: IProviderRegistry,
  threadService: ThreadService,
  turnSnapshotRepo: Pick<TurnSnapshotRepo, "create" | "getByMessage">,
  snapshotService: SnapshotService,
  db: Database,
  memoryPressureService: MemoryPressureService,
  settingsService: SettingsService,
  availability: ProviderAvailabilityService,
  scopedPreGrant: ScopedPreGrantService,
  narrativeStore: NarrativeStore,
  parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
  fileService?: ConstructorParameters<typeof TurnAdmissionDispatchCoordinator>[12],
  threadControlMcp?: McodeSessionAuthority,
  mutationReservations?: ThreadControlMutationReservationService,
  parentDurability?: ParentTurnDurability,
  workspaceEnvironmentService?: WorkspaceEnvironmentService,
  providerEventIngress?: ProviderEventIngress,
  planTurns?: PlanTurnService,
  goals?: GoalLifecycleService,
  subagents?: SubagentRosterService,
  _taskPersistence?: unknown,
  threadBranching?: ThreadBranchingService,
  eventPublication?: AgentEventPublicationRegistry,
  threadStartups?: ThreadStartupService,
  writer: ApplicationDatabaseWriter = agentStorageTestWriter(db),
  providerSwitch: ProviderSwitchService = createTestProviderSwitch({ db, writer, threadRepo, messageRepo, providerRegistry }),
): AgentService {
  if (!parentDurability) throw new Error("Parent turn durability is required by the test harness");
  const turnDiffs = new TurnDiffService(new TurnDiffRepo(db, writer));
  const tracker = new TurnFileTracker(
    (cwd, ref, path) => snapshotService.getFileAtRef(cwd, ref, path),
    () => undefined,
    "win32",
  );
  const finalizer = new TurnFinalizer();
  const runtimeCommands = new AgentRuntimeCommandPort();
  const { plans: resolvedPlans, goals: resolvedGoals, effects: featureEffects } = createTestFeatureEffects({
    db, messageRepo, threadRepo, providerRegistry, writer, runtimeCommands, parentDurability, planTurns, goals, subagents,
  });
  const publication = eventPublication ?? new AgentEventPublicationRegistry();
  const workers = createFixtureWorkers(db, writer, publication, parentDurability, providerRegistry);
  const admissions = new TurnAdmissionDispatchCoordinator(
    threadRepo,
    workspaceRepo,
    messageRepo,
    new TurnRevertStore(db),
    gitWorktrees,
    attachmentService,
    providerRegistry,
    availability,
    parentDurability,
    settingsService,
    resolvedPlans,
    resolvedGoals,
    workspaceEnvironmentService,
    fileService,
    "linux",
    { listModels: (providerId) => providerRegistry.resolve(providerId).listModels() },
    workers.owner,
    undefined,
    providerSwitch,
  );
  const conversationProjection = new TurnConversationProjectionService(
    threadRepo,
    messageRepo,
    parentDurability,
  );
  const reliability = new AgentReliabilityPort();
  const continuation = new AgentTurnContinuationPort();
  const runtimePersistence = new ThreadRuntimePersistence(threadRepo);
  const eventIngress = providerEventIngress ?? new ProviderEventIngress();
  const testThreadControl = threadControlMcp ?? {
    activate: () => undefined,
    revoke: () => undefined,
  } as unknown as McodeSessionAuthority;
  const testContainer = container.createChildContainer();
  const gitRepository = new GitRepositoryService(workspaceRepo, new FakeGitExecutor());
  testContainer.registerInstance(TURN_RUNTIME_PERSISTENCE, runtimePersistence);
  testContainer.registerInstance(TURN_FINALIZER, finalizer);
  testContainer.registerInstance("TurnFileTracker", tracker);
  testContainer.registerInstance("WorkerOwnedTurnRuntime", workers);
  testContainer.registerInstance("ExecutionFileEvidenceCoordinator", new ExecutionFileEvidenceCoordinator(tracker, turnDiffs));
  testContainer.registerInstance("WorkerTurnSnapshotService", snapshotService);
  testContainer.registerInstance(TURN_ADMISSION_DISPATCH_COORDINATOR, admissions);
  testContainer.registerInstance(TurnConversationProjectionService, conversationProjection);
  testContainer.registerInstance(ThreadCreationCoordinator, new ThreadCreationCoordinator(
    threadRepo,
    () => threadService,
    admissions,
    gitRepository,
      workspaceRepo,
      new ThreadStartupFetchDecisions(),
    () => threadBranching,
    () => planTurns,
    () => threadStartups,
  ));
  testContainer.registerInstance("IProviderRegistry", providerRegistry);
  testContainer.registerInstance(MemoryPressureService, memoryPressureService);
  testContainer.registerInstance(ScopedPreGrantService, scopedPreGrant);
  testContainer.registerInstance(McodeSessionAuthority, testThreadControl);
  testContainer.registerInstance(
    ThreadControlMutationReservationService,
    mutationReservations ?? new ThreadControlMutationReservationService(),
  );
  testContainer.registerInstance(ProviderSwitchService, providerSwitch);
  testContainer.registerInstance(ProviderEventIngress, eventIngress);
  testContainer.registerInstance(TURN_FEATURE_EFFECTS, featureEffects);
  testContainer.registerInstance(AgentRuntimeCommandPort, runtimeCommands);
  testContainer.registerInstance(AgentEventPublicationRuntimePort, new AgentEventPublicationRuntimePort());
  testContainer.registerInstance(AgentTurnContinuationPort, continuation);
  testContainer.registerInstance(AgentReliabilityPort, reliability);
  testContainer.registerInstance(AgentEventPublicationRegistry, publication);
  testContainer.registerInstance(PARENT_TURN_DURABILITY, parentDurability);
  testContainer.registerInstance(NarrativeStore, narrativeStore);
  testContainer.registerInstance(ParentAssistantTextCheckpointService, parentAssistantTextCheckpoints);
  testContainer.registerInstance("Database", db);
  testContainer.registerInstance(ApplicationDatabaseWriter, writer);
  testContainer.registerInstance(TurnDiffService, turnDiffs);
  testContainer.register<TurnRuntimeEventControl>(TURN_RUNTIME_EVENT_CONTROL, {
    useFactory: (c) => c.resolve(TurnRuntimeController),
  });
  testContainer.register(ProviderTurnEventApplication, { useClass: ProviderTurnEventApplication }, { lifecycle: Lifecycle.Singleton });
  testContainer.register(TurnRuntimeController, { useClass: TurnRuntimeController }, { lifecycle: Lifecycle.Singleton });
  testContainer.register(AgentService, { useClass: AgentService }, { lifecycle: Lifecycle.Singleton });
  const service = testContainer.resolve(AgentService);
  testPublicationCleanup.set(service, observeWorkerPublications(
    (event) => testPublicationObservers.get(service)?.(event),
    () => db.query<{ id: string }, []>("SELECT id FROM threads").all().map((thread) => thread.id),
  ));
  const runtimeController = testContainer.resolve(TurnRuntimeController);
  testMessageRepos.set(service, messageRepo);
  testEventPublications.set(service, publication);
  testReliabilityPorts.set(service, reliability);
  testContinuations.set(service, continuation);
  testProviderTurnStarts.set(service, async (threadId) => {
    await workers.whenReady();
    const thread = threadRepo.findById(threadId);
    if (!thread) throw new Error("Provider fixture thread is missing");
    const opened = await runtimeController.openProviderTurn({ threadId, notice: "Provider continuation" });
    if (opened.kind !== "opened") throw new Error("Provider fixture turn was declined");
    return opened.routing.executionId;
  });
  const eventSequences = new Map<string, number>();
  const fencedExecutions = new Set<string>();
  let pendingProviderEvents = Promise.resolve();
  async function deliverProviderEvent(parsed: ProviderRuntimeEvent, providerId: ProviderId): Promise<void> {
    let owned = workers.owner.current(parsed.event.threadId);
    if (!owned && parsed.event.type === "turnStarted") {
      await runtimeController.openProviderTurn({ threadId: parsed.event.threadId, notice: "Provider continuation" });
      owned = workers.owner.current(parsed.event.threadId);
    }
    if (!owned || (parsed.event.turnExecutionId && parsed.event.turnExecutionId !== owned.execution.executionId)) return;
    const execution = owned.execution;
    const attempt = parsed.deliveryAttempt ?? 1;
    const sequence = (eventSequences.get(execution.executionId) ?? 0) + 1;
    eventSequences.set(execution.executionId, sequence);
    const route = workers.providerEvents.resolve(execution.executionId, providerId);
    if (route.kind !== "worker") return;
    const itemId = "fixture:" + execution.executionId + ":item:" + sequence;
    const eventId = "fixture:" + execution.executionId + ":event:" + sequence;
    const now = new Date().toISOString();
    const receipt = await route.submit({
      ...execution, batchId: eventId, deliveryAttempt: attempt, phase: "running",
      events: [{
        eventId, routing: { ...execution, itemId }, sourceProviderId: providerId,
        sourceIdentities: [], sourceSequence: sequence, providerTimestamp: now,
        payload: { type: "item.recorded", item: {
          id: itemId, threadId: execution.threadId, turnId: execution.turnId, kind: "system",
          providerIdentities: [], createdAt: now, updatedAt: now,
          payload: { projection: "providerRuntimeEvent", runtimeEvent: {
            ...parsed, deliveryAttempt: attempt,
            event: { ...parsed.event, turnExecutionId: execution.executionId },
          } },
        } },
      }],
    });
    if (receipt.providerEvents.length > 0) eventIngress.acceptProjectedCommitted(receipt.providerEvents);
  }
  for (const provider of providerRegistry.resolveAll()) {
    if (!(provider instanceof NodeEvents.EventEmitter)) continue;
    wrapProviderEmitterForRuntimeEvents(provider);
    Object.assign(provider, {
      fenceCanonicalTurnEvents: async (routing: { executionId: string }) => {
        fencedExecutions.add(routing.executionId);
        await pendingProviderEvents;
      },
      retireCanonicalTurnEvents: async (routing: { executionId: string }) => {
        fencedExecutions.add(routing.executionId);
        await pendingProviderEvents;
      },
    });
    providerRuntimePublishers.set(provider, (input) => {
      const parsed = fixtureRuntimeEvent(input);
      const executionId = parsed.event.turnExecutionId
        ?? workers.owner.current(parsed.event.threadId)?.execution.executionId;
      if (executionId && fencedExecutions.has(executionId)) return;
      pendingProviderEvents = pendingProviderEvents.then(async () => {
        if (executionId && fencedExecutions.has(executionId)) return;
        await deliverProviderEvent(parsed, provider.id);
      });
    });
  }
  testWorkers.set(service, workers);
  testProviderDrains.set(service, async () => {
    await workers.whenReady();
    await pendingProviderEvents;
  });
  testTrackers.set(service, tracker);
  testTurnDiffs.set(service, turnDiffs);
  testProviderEventIngresses.set(service, eventIngress);
  testProviderApplications.set(service, testContainer.resolve(ProviderTurnEventApplication));
  testGoalLifecycles.set(service, resolvedGoals);
  registerAgentStorageTestProducer(db, () => drainAgentServicePersistenceForTest(service));
  return service;
}

/** A switch service over the test database whose audit copies land in a throwaway directory. */
export function createTestProviderSwitch({ db, writer, threadRepo, messageRepo, providerRegistry, recovery }: {
  db: Database; writer: ApplicationDatabaseWriter; threadRepo: ThreadRepo; messageRepo: MessageRepo;
  providerRegistry: IProviderRegistry; recovery?: Pick<TurnRecoveryService, "retryErroredTurn">;
}): ProviderSwitchService {
  const mcodeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-switch-"));
  return new ProviderSwitchService(
    threadRepo,
    new ThreadProviderSessionRepo(db, writer),
    messageRepo,
    new ToolCallRecordRepo(db, writer),
    HandoffStorage.forTesting({ mcodeDirFn: () => mcodeDir }),
    providerRegistry,
    recovery ?? { retryErroredTurn: () => Promise.reject(new Error("No recovery service in this test")) },
    writer,
  );
}

function createTestFeatureEffects({ db, messageRepo, threadRepo, providerRegistry, writer, runtimeCommands, parentDurability, planTurns, goals, subagents }: {
  db: Database; messageRepo: MessageRepo;
  threadRepo: ThreadRepo; providerRegistry: IProviderRegistry; writer: ApplicationDatabaseWriter;
  runtimeCommands: AgentRuntimeCommandPort; parentDurability: ParentTurnDurability;
  planTurns?: PlanTurnService; goals?: GoalLifecycleService; subagents?: SubagentRosterService;
}) {
  const resolvedPlans = planTurns ?? new PlanTurnService(threadRepo, providerRegistry,
    new PlanQuestionService(messageRepo, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer),
    new AgentTurnCommandPort(runtimeCommands));
  const resolvedGoals = goals ?? new GoalLifecycleService(
    threadRepo,
    providerRegistry,
    writer,
    runtimeCommands,
    parentDurability,
  );
  const featureEffects = new TurnFeatureEffects(
    resolvedPlans,
    resolvedGoals,
    subagents ?? ({ stopDescendants: () => undefined, toolChanged: () => undefined, turnFinished: () => undefined } as unknown as SubagentRosterService),
  );
  return { plans: resolvedPlans, goals: resolvedGoals, effects: featureEffects };
}

function createFixtureWorkers(
  db: Database,
  writer: ApplicationDatabaseWriter,
  publication: AgentEventPublicationRegistry,
  parentDurability: ParentTurnDurability,
  providerRegistry: IProviderRegistry,
): WorkerOwnedTurnRuntime {
  const canonical = parentDurability instanceof CanonicalAgentBoundary
    ? parentDurability
    : new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => undefined);
  if (!publication.isBound()) publication.bind(() => undefined);
  const workers = new WorkerOwnedTurnRuntime(new CanonicalAgentWriterClient(writer), publication, canonical);
  const progress = workers.progress;
  if (!progress) throw new Error("Worker fixture has no accepted progress owner");
  canonical.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
  for (const provider of providerRegistry.resolveAll()) {
    Object.assign(provider, {
      setCanonicalTurnDeliveryFailureHandler: () => undefined,
      fenceCanonicalTurnEvents: async () => undefined,
      retireCanonicalTurnEvents: async () => undefined,
    });
  }
  return workers;
}

function fixtureRuntimeEvent(input: unknown): ProviderRuntimeEvent {
  if (!input || typeof input !== "object") throw new Error("Invalid provider fixture event");
  return ProviderRuntimeEventSchema().parse("event" in input ? input : { event: input });
}
