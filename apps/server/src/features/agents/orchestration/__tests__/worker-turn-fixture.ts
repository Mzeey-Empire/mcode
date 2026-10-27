import "reflect-metadata";
import { observeWorkerPublications } from "./worker-publication-observer.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { TurnDiffService } from "../../turns/turn-diff-service.js";
import type { ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { container } from "tsyringe";
import { vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { AgentEventPublicationRuntimePort } from "../agent-runtime-internal-ports.js";
import { AgentEventPublicationService } from "../agent-event-publication-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { IProviderRegistry, ProviderId, TurnRequest } from "@mcode/contracts/providers/interfaces";
import type { ProviderHostPorts } from "@mcode/providers";
import { setupContainer } from "../../../../application/composition/container.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { AgentService } from "../agent-service.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SnapshotRefPins } from "../../../projects/diffs/snapshots/snapshot-ref-pins.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";

export async function openWorkerServiceFixture(providerId: ProviderId = "codex") {
  container.reset();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worker-turn-"));
  const previousDatabasePath = process.env.MCODE_DB_PATH;
  const previousDataDirectory = process.env.MCODE_DATA_DIR;
  process.env.MCODE_DATA_DIR = NodePath.join(directory, "data");
  process.env.MCODE_DB_PATH = NodePath.join(directory, "app.sqlite");
  NodeFS.mkdirSync(process.env.MCODE_DATA_DIR, { recursive: true });
  await setupContainer(directory);
  const writer = container.resolve(ApplicationDatabaseWriter);
  const workers = container.resolve(WorkerOwnedTurnRuntime);
  await workers.whenReady();
  const sent: TurnRequest[] = [];
  const fenced = new Set<string>();
  const pending = new Set<Promise<void>>();
  const canonicalEvents: CanonicalAgentEventEnvelope[] = [];
  function drain(): Promise<void> {
    return Promise.all(pending).then(() => undefined);
  }
  const published: AgentEvent[] = [];
  const provider = Object.assign(new NodeEvents.EventEmitter(), {
    id: providerId,
    descriptor: { id: providerId, capabilities: [{ name: "child-cancellation" as const, support: "supported" as const }] },
    supportsCompletion: false,
    maxInputCharactersPerTurn: 100_000,
    sendTurn: vi.fn(async (turn: TurnRequest) => { sent.push(turn); }),
    stopSession: vi.fn(async (_sessionId: string): Promise<void> => undefined),
    interruptChildTurn: vi.fn(async (_sessionId: string, _threadId: string, _turnId: string): Promise<void> => undefined),
    shutdown: () => undefined,
    listModels: async () => [],
    setCanonicalTurnDeliveryFailureHandler: () => undefined,
    fenceCanonicalTurnEvents: async (routing: { executionId: string }) => {
      fenced.add(routing.executionId);
      await drain();
    },
    retireCanonicalTurnEvents: async (routing: { executionId: string }) => {
      fenced.add(routing.executionId);
      await drain();
    },
  });
  const providerRegistry: IProviderRegistry = {
    resolve: () => provider, resolveAll: () => [provider], shutdown: async () => undefined,
  };
  container.registerInstance("IProviderRegistry", providerRegistry);
  vi.spyOn(container.resolve(ProviderAvailabilityService), "assertUsable").mockReturnValue(undefined);
  const publication = container.resolve(AgentEventPublicationRegistry);
  const workspace = await container.resolve(WorkspaceRepo).create("Worker fixture", directory);
  const threads = container.resolve(ThreadRepo);
  const progress = workers.progress;
  const planFiles = workers.planFiles;
  if (!progress || !planFiles) throw new Error("Worker fixture has no accepted feature owner");
  workers.bindPlanPhaseChanged((threadId) => threads.publishPlanPhase(threadId));
  container.resolve(PlanQuestionService).bindAcceptedProgress(progress);
  container.resolve(PlanTurnService).bindPlanProjection(progress, planFiles);
  container.resolve(CanonicalAgentBoundary).bindAcceptedSynthesizedPublications((threadId, events) =>
    progress.acceptSynthesizedPublications(threadId, events));
  const thread = await threads.create(workspace.id, "Worker turn", "direct", "main", true, providerId);
  const service = container.resolve(AgentService);
  const host = container.resolve<ProviderHostPorts>("ProviderHostPorts");
  let sequence = 0;
  const messages = container.resolve(MessageRepo);
  const tools = container.resolve(ToolCallRecordRepo);
  const thoughts = container.resolve(ThoughtSegmentRepo);
  const hooks = container.resolve(HookExecutionRepo);
  const db = container.resolve<Database>("Database");
  const stopObserving = observeWorkerPublications(
    (event) => published.push(event),
    () => db.query<{ id: string }, []>("SELECT id FROM threads").all().map((row) => row.id),
    (events) => canonicalEvents.push(...events),
  );
  const eventPublication = new AgentEventPublicationService({
    runtime: container.resolve(AgentEventPublicationRuntimePort),
    threads,
    pullRequests: { schedule: () => undefined },
    publishThreadStatus: (payload) => broadcast("thread.status", payload),
  });
  publication.bind((event) => {
    published.push(event);
    eventPublication.publish(event);
  }, () => eventPublication.drain());
  publication.start();
  async function submit(event: AgentEvent, extension?: ProviderRuntimeEvent["extension"], planCapture?: ProviderRuntimeEvent["planCapture"]): Promise<void> {
    const executionId = event.turnExecutionId;
    if (!executionId) throw new Error("Worker fixture event needs an execution identity");
    const owned = workers.owner.current(event.threadId);
    if (!owned || owned.execution.executionId !== executionId) {
      throw new Error("Worker fixture event has no execution owner");
    }
    const routing = { ...owned.execution, deliveryAttempt: 1 };
    sequence += 1;
    const itemId = "fixture:" + executionId + ":item:" + sequence;
    const eventId = "fixture:" + executionId + ":event:" + sequence;
    const now = new Date().toISOString();
    await host.events.submit({
      ...routing, executionId: routing.executionId, batchId: eventId, phase: "running",
      events: [{
        eventId, sourceProviderId: provider.id, sourceIdentities: [], sourceSequence: sequence,
        providerTimestamp: now, routing: { ...owned.execution, itemId },
        payload: { type: "item.recorded", item: {
          id: itemId, threadId: event.threadId, turnId: owned.execution.turnId, kind: "system",
          providerIdentities: [], createdAt: now, updatedAt: now,
          payload: { projection: "providerRuntimeEvent", runtimeEvent: {
            event, extension, planCapture,
          } },
        } },
      }],
    });
    await progress.waitForSaved(event.threadId);
  }
  function emit(event: AgentEvent, extension?: ProviderRuntimeEvent["extension"], planCapture?: ProviderRuntimeEvent["planCapture"]): Promise<void> {
    if (event.turnExecutionId && fenced.has(event.turnExecutionId)) return Promise.resolve();
    const task = submit(event, extension, planCapture);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function assistant() {
    return messages.listByThread(thread.id, 100).messages.filter((message) => message.role === "assistant").at(-1);
  }
  async function stop() {
    const result = await service.stopSession(thread.id, { by: "user" });
    await progress.waitForTerminalSaves(thread.id);
    return result;
  }
  async function close(): Promise<void> {
    await drain();
    await service.stopAll();
    await drain();
    await workers.progress?.waitForTerminalSaves(thread.id);
    await workers.close();
    await container.resolve(SnapshotRefPins).drain();
    stopObserving();
    await writer.close();
    db.close(true);
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (previousDataDirectory === undefined) delete process.env.MCODE_DATA_DIR;
    else process.env.MCODE_DATA_DIR = previousDataDirectory;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
  return {
    diffs: container.resolve(TurnDiffService), directory, writer, db, workers, service, thread,
    workspace, provider, providerRegistry, sent, host, threads, messages, tools, thoughts, hooks,
    canonical: container.resolve(CanonicalAgentBoundary), canonicalEvents, published, emit, drain, stop, assistant, close,
  };
}

export async function openWorkerTurnFixture(options: { planning?: boolean; questions?: boolean } = {}) {
  const fixture = await openWorkerServiceFixture();
  const question = options.planning
    ? await fixture.messages.create(fixture.thread.id, "assistant", "```plan-questions\n[]\n```", 1)
    : null;
  await fixture.service.sendMessage({
    threadId: fixture.thread.id, content: "Do the work", provider: "codex", model: "gpt-5.5", permissionMode: "full",
    ...(options.planning || options.questions ? { interactionMode: "plan" as const } : {}),
    ...(question ? { markPlanAnswerForMessageId: question.id } : {}),
  });
  await vi.waitFor(() => {
    if (fixture.sent.length !== 1) throw new Error("Worker provider dispatch is pending");
  });
  const turn = fixture.sent[0];
  if (!turn) throw new Error("Worker fixture did not reach provider dispatch");
  const routing = { threadId: fixture.thread.id, turnId: turn.turnId, executionId: turn.turnExecutionId, deliveryAttempt: 1 };
  const emit: typeof fixture.emit = (event, extension, planCapture) => fixture.emit(
    { ...event, threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId }, extension, planCapture,
  );
  async function finish(): Promise<void> {
    await emit({ type: "turnComplete", threadId: fixture.thread.id,
      reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "codex" });
    await emit({ type: "ended", threadId: fixture.thread.id });
    await vi.waitFor(() => {
      if (fixture.workers.owner.current(fixture.thread.id)) throw new Error("Worker terminal release is pending");
    });
  }
  return { ...fixture, turn, routing, emit, finish };
}
