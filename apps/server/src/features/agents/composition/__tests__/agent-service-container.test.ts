import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import type { WebSocket } from "ws";
import { container } from "tsyringe";
import type { AgentEvent, IAgentProvider, IProviderRegistry, TurnRequest } from "@mcode/contracts";

import { setupContainer } from "../../../../application/composition/container.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { ExecutionThreadWorkerPort } from "../../execution/execution-worker-port.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { ExecutionMailboxOwner } from "../../execution/execution-mailbox-owner.js";
import { ExecutionMailboxScheduler } from "../../execution/execution-mailbox-scheduler.js";
import { ExecutionProviderEventOwnership } from "../../execution/execution-provider-event-ownership.js";
import { ExecutionWorkerLossCoordinator } from "../../execution/execution-worker-loss-coordinator.js";
import { ExecutionFileEvidenceCoordinator } from "../../execution/execution-file-evidence-coordinator.js";
import { AgentService } from "../../orchestration/agent-service.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import { TurnRuntimeController } from "../../orchestration/turn-runtime-controller.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { TURN_FEATURE_EFFECTS, TurnFeatureEffects } from "../../turns/turn-feature-effects.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { addClient, removeClient } from "../../../../application/transport/push.js";

describe("AgentService container composition", () => {
  let database: Database | undefined;
  let workerRuntime: WorkerOwnedTurnRuntime | undefined;
  let temporaryDirectory: string | undefined;
  let pushClient: WebSocket | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(async () => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-service-composition-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    setupContainer(temporaryDirectory);
    database = container.resolve<Database>("Database");
    workerRuntime = container.resolve(WorkerOwnedTurnRuntime);
    await workerRuntime.whenReady();
  });

  afterEach(async () => {
    if (pushClient) removeClient(pushClient);
    pushClient = undefined;
    await workerRuntime?.close();
    workerRuntime = undefined;
    database?.close(true);
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("resolves AgentService through the production container with explicit feature effects", () => {
    expect(container.resolve<TurnFeatureEffects>(TURN_FEATURE_EFFECTS)).toBeInstanceOf(TurnFeatureEffects);
    expect(container.resolve(ExecutionFileEvidenceCoordinator))
      .toBe(container.resolve(ExecutionFileEvidenceCoordinator));
    expect(container.resolve(AgentService)).toBeInstanceOf(AgentService);
  });

  it("starts one writer and a fixed execution pool from the opened database", async () => {
    workerRuntime = container.resolve(WorkerOwnedTurnRuntime);
    await workerRuntime.whenReady();

    expect(container.resolve(CanonicalAgentWriterClient)).toBe(workerRuntime.writer);
    expect(container.resolve(CanonicalExecutionWriterPort)).toBe(workerRuntime.writerPort);
    expect(container.resolve(ExecutionWorkerLossCoordinator)).toBe(workerRuntime.workerLoss);
    expect(container.resolve(ExecutionMailboxScheduler)).toBe(workerRuntime.scheduler);
    expect(container.resolve(ExecutionMailboxOwner)).toBe(workerRuntime.owner);
    expect(container.resolve(ExecutionProviderEventOwnership)).toBe(workerRuntime.providerEvents);
    expect(workerRuntime.scheduler.depth()).toMatchObject({
      pending: 0, activeExecutions: 0, workers: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
    });
  });

  it("resolves ThreadService when a worktree thread reaches branch validation", async () => {
    const coordinator = container.resolve(ThreadCreationCoordinator);

    await expect(coordinator.create({
      workspaceId: "missing-workspace",
      title: "Invalid worktree branch",
      mode: "worktree",
      branch: "invalid branch",
      provider: "claude",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
    })).rejects.toThrow("Branch name contains invalid characters: invalid branch");
  });

  it("commits a Codex turn through its execution owner and releases after Ended", async () => {
    const published: AgentEvent[] = [];
    const pushes: Array<{ channel: string; data: unknown }> = [];
    pushClient = capturePushes(pushes);
    let providerError: unknown;
    const provider = fakeCodexProvider(async (request) => {
      try {
      await submitCodexEvent(workerRuntime!, request, 1, { type: "textDelta",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId,
        delta: "owned answer", isFinalResponse: true });
      await submitCodexEvent(workerRuntime!, request, 2, { type: "turnComplete",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId,
        providerId: "codex", reason: "end_turn", costUsd: null, tokensIn: 1, tokensOut: 2,
        totalProcessedTokens: 3, contextWindow: undefined, cacheReadTokens: undefined });
      await submitCodexEvent(workerRuntime!, request, 3, { type: "ended",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId });
      } catch (error) {
        providerError = error;
        throw error;
      }
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind((event) => published.push(event));
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-test", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Worker turn", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id, content: "hello", permissionMode: "default" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(providerError).toBeUndefined();
    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining([
      "turnStarted", "textDelta", "turnComplete", "ended",
    ]));
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("completed");
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
    expect(pushes.filter((push) => push.channel === "turn.persisted")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ threadId: thread.id,
        outcome: "completed", executionId: expect.any(String), toolCallCount: 0 }) }),
    ]);
    expect(pushes.filter((push) => push.channel === "thread.status")).toEqual([
      expect.objectContaining({ data: { threadId: thread.id, status: "completed" } }),
    ]);
  });

  it("returns from Stop after a durable worker terminal that preserves partial text", async () => {
    const published: AgentEvent[] = [];
    const pushes: Array<{ channel: string; data: unknown }> = [];
    pushClient = capturePushes(pushes);
    const stopProvider = vi.fn(async () => undefined);
    const provider = fakeCodexProvider(async (request) => {
      await submitCodexEvent(workerRuntime!, request, 1, { type: "textDelta",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId,
        delta: "partial answer", isFinalResponse: true });
    }, stopProvider);
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind((event) => published.push(event));
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-stop", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Worker stop", "direct", "main", true, "codex");
    const service = container.resolve(AgentService);

    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "default" });
    const stopped = await service.stopSession(thread.id);

    expect(stopped.status).toBe("cancelled");
    expect(stopProvider).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(published.some((event) => event.type === "ended" && event.outcome === "interrupted")).toBe(true);
    expect(container.resolve(MessageRepo).listByThread(thread.id, 10).messages
      .some((message) => message.role === "assistant" && message.content === "partial answer")).toBe(true);
    expect(workerRuntime?.owner.current(thread.id)).toBeUndefined();
    expect(pushes.filter((push) => push.channel === "turn.persisted")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ threadId: thread.id,
        outcome: "cancelled", executionId: expect.any(String) }) }),
    ]);
    expect(pushes.filter((push) => push.channel === "thread.status")).toEqual([
      expect.objectContaining({ data: { threadId: thread.id, status: "interrupted" } }),
    ]);
  });

  it("confirms a stopped turn without assistant text through its durable terminal push", async () => {
    const pushes: Array<{ channel: string; data: unknown }> = [];
    pushClient = capturePushes(pushes);
    registerFakeCodex(fakeCodexProvider(async () => undefined));
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-empty-stop", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Empty worker stop", "direct", "main", true, "codex");
    const service = container.resolve(AgentService);

    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "default" });
    const stopped = await service.stopSession(thread.id);

    expect(stopped.status).toBe("cancelled");
    expect(container.resolve(MessageRepo).listByThread(thread.id, 10).messages.map((message) => message.role))
      .toEqual(["user"]);
    expect(pushes.filter((push) => push.channel === "turn.persisted")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ threadId: thread.id,
        messageId: null, toolCallCount: 0, outcome: "cancelled", executionId: stopped.turnExecutionId }) }),
    ]);
    expect(pushes.filter((push) => push.channel === "thread.status")).toEqual([
      expect.objectContaining({ data: { threadId: thread.id, status: "interrupted" } }),
    ]);
    expect(workerRuntime?.owner.current(thread.id)).toBeUndefined();
  });

  it("publishes a provider cancelled Ended event from the worker terminal receipt", async () => {
    const published: AgentEvent[] = [];
    const provider = fakeCodexProvider(async (request) => {
      await submitCodexEvent(workerRuntime!, request, 1, { type: "ended",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "cancelled" });
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind((event) => published.push(event));
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-cancelled", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Provider cancelled", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(published.some((event) => event.type === "ended" && event.outcome === "interrupted")).toBe(true);
  });

  it("finishes the exact owned turn when canonical delivery fails after provider send", async () => {
    let sent: TurnRequest | undefined;
    let reportFailure: ((routing: { threadId: string; turnId: string;
      executionId: string; deliveryAttempt: number }, error: Error) => void | Promise<void>) | undefined;
    const provider = fakeCodexProvider(async (request) => {
      sent = request;
    });
    Object.assign(provider, {
      setCanonicalTurnDeliveryFailureHandler: (handler: NonNullable<typeof reportFailure>) => {
        reportFailure = handler;
      },
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-delivery", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Delivery failure", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    if (!sent || !reportFailure) throw new Error("Expected an exact canonical delivery route");
    const routing = { threadId: sent.threadId, turnId: sent.turnId,
      executionId: sent.turnExecutionId, deliveryAttempt: 1 };
    await reportFailure({ ...routing, deliveryAttempt: 2 }, new Error("stale attempt"));
    expect(workerRuntime?.owner.current(thread.id)).toBeDefined();
    await reportFailure(routing, new Error("canonical sink failed"));
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("errored");
    expect(published.some((event) => event.type === "error" && event.error === "canonical sink failed")).toBe(true);
  });

  it("admits seven concurrent owned turns and releases each terminal", async () => {
    const provider = fakeCodexProvider(async (request) => {
      await submitCodexEvent(workerRuntime!, request, 1, { type: "turnComplete",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId,
        providerId: "codex", reason: "end_turn", costUsd: null, tokensIn: 1, tokensOut: 1 });
      await submitCodexEvent(workerRuntime!, request, 2, { type: "ended",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId });
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-concurrent", temporaryDirectory!);
    const threads = Array.from({ length: 7 }, (_, index) =>
      container.resolve(ThreadRepo).create(workspace.id, `Concurrent ${index}`, "direct", "main", true, "codex"));
    const service = container.resolve(AgentService);

    await Promise.all(threads.map((thread) => service.sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" })));
    await waitFor(() => threads.every((thread) => workerRuntime?.owner.current(thread.id) === undefined));

    expect(published.filter((event) => event.type === "turnStarted")).toHaveLength(7);
    expect(published.filter((event) => event.type === "turnComplete")).toHaveLength(7);
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
  });

  it("interrupts and releases a rejected provider event whose ordinal cannot be replayed", async () => {
    let reportFailure: ((routing: { threadId: string; turnId: string;
      executionId: string; deliveryAttempt: number }, error: Error) => void | Promise<void>) | undefined;
    const provider = fakeCodexProvider(async (request) => {
      try {
        await submitCodexEvent(workerRuntime!, request, 1, { type: "turnStarted",
          threadId: request.threadId, turnExecutionId: request.turnExecutionId });
      } catch (error) {
        if (!reportFailure) throw error;
        await reportFailure({ threadId: request.threadId, turnId: request.turnId,
          executionId: request.turnExecutionId, deliveryAttempt: 1 }, error as Error);
      }
    });
    Object.assign(provider, { setCanonicalTurnDeliveryFailureHandler: (handler: NonNullable<typeof reportFailure>) => {
      reportFailure = handler;
    } });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-rejected", temporaryDirectory!);
    const thread = container.resolve(ThreadRepo).create(workspace.id, "Rejected event", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("interrupted");
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
  });

  it("releases a crashed execution while a peer remains runnable", async () => {
    const provider = fakeCodexProvider(async (request) => {
      void request;
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = container.resolve(WorkspaceRepo).create("worker-crash", temporaryDirectory!);
    const threads = container.resolve(ThreadRepo);
    const lost = threads.create(workspace.id, "Lost worker", "direct", "main", true, "codex");
    const peer = threads.create(workspace.id, "Peer worker", "direct", "main", true, "codex");
    const service = container.resolve(AgentService);
    await service.sendMessage({ threadId: lost.id, content: "one", permissionMode: "default" });
    await service.sendMessage({ threadId: peer.id, content: "two", permissionMode: "default" });
    const assignment = requireValue(workerRuntime?.owner.current(lost.id), "Expected lost execution owner");
    const peerAssignment = requireValue(workerRuntime?.owner.current(peer.id), "Expected peer execution owner");
    expect(assignment.lease.workerIndex).not.toBe(peerAssignment.lease.workerIndex);

    const ports = (workerRuntime as unknown as { initialWorkers: ExecutionThreadWorkerPort[] }).initialWorkers;
    const crashed = requireValue(ports[assignment.lease.workerIndex], "Lost worker port was not found");
    crashed.terminate();
    crashed.onclose?.();
    await waitFor(() => workerRuntime?.owner.current(lost.id) === undefined);
    expect(await workerRuntime?.workerLoss.waitForRecovery(assignment.lease.workerIndex))
      .toMatchObject({ kind: "recovered" });

    expect(container.resolve(TurnRuntimeController).snapshot(lost.id)?.phase).toBe("interrupted");
    expect(workerRuntime?.owner.current(peer.id)?.execution.executionId).toBe(peerAssignment.execution.executionId);
    expect((await service.stopSession(peer.id)).status).toBe("cancelled");
  });

  function registerFakeCodex(provider: IAgentProvider): void {
    container.registerInstance<IProviderRegistry>("IProviderRegistry", {
      resolve: () => provider, resolveAll: () => [provider], shutdown: () => undefined,
    });
    container.registerInstance(ProviderAvailabilityService, {
      assertUsable: () => undefined,
    } as ProviderAvailabilityService);
  }
});

function fakeCodexProvider(
  sendTurn: (request: TurnRequest) => Promise<void>,
  stopSession: (sessionId: string) => Promise<void> = async () => undefined,
): IAgentProvider {
  return Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const,
    descriptor: { id: "codex" },
    supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16000,
    sendTurn,
    stopSession,
    shutdown: () => undefined,
    listModels: async () => [],
    setCanonicalTurnEventDeliveryEnabled: () => undefined,
    setCanonicalTurnDeliveryFailureHandler: () => undefined,
    fenceCanonicalTurnEvents: async () => undefined,
    retireCanonicalTurnEvents: async () => undefined,
  }) as IAgentProvider;
}

async function submitCodexEvent(
  runtime: WorkerOwnedTurnRuntime,
  request: TurnRequest,
  sequence: number,
  event: AgentEvent,
): Promise<void> {
  const route = runtime.providerEvents.resolve(request.turnExecutionId, "codex");
  if (route.kind !== "worker") throw new Error("Codex turn did not bind its worker route");
  const itemId = `codex:${request.turnExecutionId}:item:${sequence}`;
  const eventId = `codex:${request.turnExecutionId}:event:${sequence}`;
  const timestamp = new Date().toISOString();
  await route.submit({ threadId: request.threadId, turnId: request.turnId,
    executionId: request.turnExecutionId, phase: "running", deliveryAttempt: 1, batchId: eventId,
    events: [{ eventId, sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
      providerTimestamp: timestamp,
      routing: { threadId: request.threadId, turnId: request.turnId,
        executionId: request.turnExecutionId, itemId },
      payload: { type: "item.recorded", item: { id: itemId, threadId: request.threadId,
        turnId: request.turnId, kind: "system", providerIdentities: [],
        payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } },
        createdAt: timestamp, updatedAt: timestamp } } }],
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worker turn release");
}

function capturePushes(pushes: Array<{ channel: string; data: unknown }>): WebSocket {
  const client = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send: (payload: string, complete: (error?: Error) => void) => {
      const message = JSON.parse(payload) as { channel: string; data: unknown };
      pushes.push(message);
      complete();
    } } as unknown as WebSocket;
  addClient(client);
  return client;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
