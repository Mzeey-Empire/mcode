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
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
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
import { ProviderTurnEventApplication } from "../../turns/provider-turn-event-application.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import type { WorkerOwnedProviderEventResult } from "../../../providers/composition/provider-host-ports.js";
import { addClient, removeClient, subscribeClientToThread } from "../../../../application/transport/push.js";

describe("AgentService container composition", () => {
  let database: Database | undefined;
  let workerRuntime: WorkerOwnedTurnRuntime | undefined;
  let databaseWriter: ApplicationDatabaseWriter | undefined;
  let temporaryDirectory: string | undefined;
  let pushClient: WebSocket | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(async () => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-service-composition-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    await setupContainer(temporaryDirectory);
    databaseWriter = container.resolve(ApplicationDatabaseWriter);
    database = container.resolve<Database>("Database");
    workerRuntime = container.resolve(WorkerOwnedTurnRuntime);
    await workerRuntime.whenReady();
  });

  afterEach(async () => {
    if (pushClient) removeClient(pushClient);
    pushClient = undefined;
    await workerRuntime?.close();
    workerRuntime = undefined;
    await databaseWriter?.close();
    databaseWriter = undefined;
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
    expect(container.resolve(ApplicationDatabaseWriter)).toBe(databaseWriter);
    expect(() => database?.run("UPDATE workspaces SET name = 'forbidden'"))
      .toThrow(/readonly/i);

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
    const workspace = await container.resolve(WorkspaceRepo).create("worker-test", temporaryDirectory!);
    const threads = container.resolve(ThreadRepo);
    const thread = await threads.create(workspace.id, "Worker turn", "direct", "main", true, "claude");
    await threads.updateSettings(thread.id, { thinking: true });

    await container.resolve(AgentService).sendMessage({
      threadId: thread.id, content: "hello", provider: "codex", model: "gpt-5.6-luna",
      permissionMode: "full", reasoningLevel: "high", codexFastMode: false,
    });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(providerError).toBeUndefined();
    expect(threads.findById(thread.id)).toMatchObject({
      provider: "codex", model: "gpt-5.6-luna", permission_mode: "full",
      reasoning_level: "high", codex_fast_mode: false, thinking: true,
    });
    expect(pushes.filter((push) => push.channel === "thread.modelUpdated")).toEqual([
      { type: "push", channel: "thread.modelUpdated", data: { threadId: thread.id, model: "gpt-5.6-luna", provider: "codex" } },
    ]);
    expect(published.map((event) => event.type)).toContain("turnStarted");
    await waitFor(() => canonicalProviderEvents(thread.id).some((event) => event.type === "textDelta" && event.delta === "owned answer")
      && canonicalPayloadTypes(thread.id).includes("turn.completed"));
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("completed");
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
  });

  it.each([false, true])("publishes a session notice through the production progress owner while its SQLite save is held (scoped=%s)", async (scoped) => {
    registerFakeCodex(fakeCodexProvider(async () => undefined));
    const publication = container.resolve(AgentEventPublicationRegistry);
    const legacyPublications: AgentEvent[] = [];
    publication.bind((event) => legacyPublications.push(event));
    publication.start();
    const pushes: Array<{ channel: string; data: unknown }> = [];
    pushClient = capturePushes(pushes);
    const workspace = await container.resolve(WorkspaceRepo).create("notice-owner", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Notice turn", "direct", "main", true, "codex");
    subscribeClientToThread(pushClient, thread.id);
    await container.resolve(AgentService).sendMessage({ threadId: thread.id, content: "hello", provider: "codex", permissionMode: "full" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) !== undefined);
    const writer = container.resolve(CanonicalAgentWriterClient);
    const append = writer.appendAccepted.bind(writer);
    let releaseSave: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { releaseSave = resolve; });
    const heldAppend: typeof writer.appendAccepted = async (...args) => { await held; return append(...args); };
    const heldWrite = vi.spyOn(writer, "appendAccepted").mockImplementation(heldAppend);
    const event: Extract<AgentEvent, { type: "system" }> = { type: "system", threadId: thread.id,
      ...(scoped ? { turnExecutionId: workerRuntime?.owner.current(thread.id)?.execution.executionId } : {}),
      subtype: "provider.notice.warning", message: "Session warning",
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "notice-session" } };
    try {
      const sourceExecutionId = event.turnExecutionId;
      expect(container.resolve(ProviderTurnEventApplication).apply({ providerId: "codex", sourceKind: "provider-runtime", event }, event, true)).toBe(true);
      expect(event.turnExecutionId).toBe(sourceExecutionId);
      expect(event.messageId).toBeDefined();
      expect(container.resolve(MessageRepo).findById(event.messageId!)).toBeUndefined();
      expect(pushes.filter((push) => push.channel === "agent.canonical").map((push) => JSON.stringify(push.data)))
        .toContainEqual(expect.stringContaining(event.messageId!));
      expect(legacyPublications.filter((published) => published.type === "system" && published.message === event.message)).toHaveLength(0);
    } finally {
      releaseSave?.();
      await waitFor(() => workerRuntime?.progress?.depth().pending === 0);
      heldWrite.mockRestore();
    }
    expect(container.resolve(MessageRepo).findById(event.messageId!)).toMatchObject({ content: "Session warning" });
  });

  it("returns from Stop after a durable worker terminal that preserves partial text", async () => {
    const published: AgentEvent[] = [];
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
    const workspace = await container.resolve(WorkspaceRepo).create("worker-stop", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Worker stop", "direct", "main", true, "codex");
    const service = container.resolve(AgentService);

    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "default" });
    const stopped = await service.stopSession(thread.id);

    expect(stopped.status).toBe("cancelled");
    expect(stopProvider).toHaveBeenCalledWith(`mcode-${thread.id}`);
    expect(workerRuntime?.owner.current(thread.id)).toBeUndefined();
  }, 15_000);

  it("confirms a stopped turn without assistant text through its durable terminal push", async () => {
    registerFakeCodex(fakeCodexProvider(async () => undefined));
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-empty-stop", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Empty worker stop", "direct", "main", true, "codex");
    const service = container.resolve(AgentService);

    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "default" });
    const stopped = await service.stopSession(thread.id);

    expect(stopped.status).toBe("cancelled");
    expect(container.resolve(MessageRepo).listByThread(thread.id, 10).messages.map((message) => message.role))
      .toEqual(["user"]);
    expect(workerRuntime?.owner.current(thread.id)).toBeUndefined();
  }, 15_000);

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
    const workspace = await container.resolve(WorkspaceRepo).create("worker-cancelled", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Provider cancelled", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    expect(published.map((event) => event.type)).toContain("turnStarted");
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("interrupted");
    await waitFor(() => canonicalPayloadTypes(thread.id).includes("turn.interrupted"));
  }, 15_000);

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
    const workspace = await container.resolve(WorkspaceRepo).create("worker-delivery", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Delivery failure", "direct", "main", true, "codex");

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
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
  });

  it("keeps explicit Stop ownership when its fenced Copilot delivery rejects after cancellation seals", async () => {
    let sent: TurnRequest | undefined;
    let reportFailure: ((routing: { threadId: string; turnId: string;
      executionId: string; deliveryAttempt: number }, error: Error) => Promise<void>) | undefined;
    const provider = Object.assign(fakeCodexProvider(async (request) => { sent = request; }), {
      id: "copilot" as const, descriptor: { id: "copilot" as const, capabilities: [] },
      setCanonicalTurnDeliveryFailureHandler: (handler: NonNullable<typeof reportFailure>) => { reportFailure = handler; },
    });
    registerFakeCodex(provider);
    const service = container.resolve(AgentService);
    const publication = container.resolve(AgentEventPublicationRegistry);
    publication.bind(() => undefined); publication.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-stop-delivery", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Stop ownership", "direct", "main", true, "copilot");
    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "full", provider: "copilot", model: "gpt-4.1" });
    const request = requireValue(sent, "Expected Copilot dispatch");
    const failure = requireValue(reportFailure, "Expected Copilot delivery handler");
    const runtime = requireValue(workerRuntime, "Expected owned runtime");
    const recover = vi.spyOn(runtime, "recoverRejected");
    const routing = { threadId: request.threadId, turnId: request.turnId,
      executionId: request.turnExecutionId, deliveryAttempt: 1 };
    await failure({ ...routing, deliveryAttempt: 2 }, new Error("stale failure"));
    await failure({ ...routing, turnId: "stale-turn" }, new Error("stale failure"));
    await failure({ ...routing, executionId: "stale-execution" }, new Error("stale failure"));
    const files = container.resolve(ExecutionFileEvidenceCoordinator);
    const seal = files.seal.bind(files);
    let lateFailure: Promise<void> | undefined;
    const sealing = vi.spyOn(files, "seal").mockImplementation((input) => {
      const frozen = seal(input);
      if (input.outcome === "cancelled" && input.executionId === request.turnExecutionId) {
        expect(runtime.providerEvents.resolve(request.turnExecutionId, "copilot").kind).toBe("rejected");
        lateFailure = failure(routing, new Error("Canonical event execution is no longer admitted"));
      }
      return frozen;
    });
    const result = await service.stopSession(thread.id);
    await requireValue(lateFailure, "Expected post-fence delivery rejection");
    expect(result).toMatchObject({ status: "cancelled", snapshot: {
      threadId: thread.id, turnExecutionId: request.turnExecutionId, phase: "cancelled" } });
    expect(sealing.mock.calls.map(([input]) => input.outcome)).toEqual(["cancelled"]);
    expect(recover).not.toHaveBeenCalled();
    expect(service.runtimeAccess().activeCount()).toBe(0);
    expect(runtime.owner.current(thread.id)).toBeUndefined();
    await waitFor(() => canonicalPayloadTypes(thread.id).includes("turn.cancelled"));
    expect(database?.query("SELECT status FROM canonical_agent_turns WHERE execution_id=?").get(request.turnExecutionId)).toEqual({ status: "Cancelled" });
    expect(canonicalPayloadTypes(thread.id).filter((type) => ["turn.completed", "turn.cancelled", "turn.errored", "turn.interrupted"].includes(type))).toEqual(["turn.cancelled"]);
    await service.sendMessage({ threadId: thread.id, content: "follow-up", permissionMode: "full", provider: "copilot", model: "gpt-4.1" });
    expect(runtime.owner.current(thread.id)?.execution.executionId).not.toBe(request.turnExecutionId);
    expect(service.runtimeAccess().activeCount()).toBe(1);
    expect((await service.stopSession(thread.id)).status).toBe("cancelled");
    expect(recover).not.toHaveBeenCalled();
  });

  it("joins a genuine delivery failure admitted before Stop and preserves its errored outcome", async () => {
    let sent: TurnRequest | undefined;
    let reportFailure: ((routing: { threadId: string; turnId: string;
      executionId: string; deliveryAttempt: number }, error: Error) => Promise<void>) | undefined;
    const provider = Object.assign(fakeCodexProvider(async (request) => { sent = request; }), {
      id: "copilot" as const, descriptor: { id: "copilot" as const, capabilities: [] },
      setCanonicalTurnDeliveryFailureHandler: (handler: NonNullable<typeof reportFailure>) => { reportFailure = handler; },
    });
    registerFakeCodex(provider);
    const service = container.resolve(AgentService);
    const publication = container.resolve(AgentEventPublicationRegistry);
    publication.bind(() => undefined); publication.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-failure-before-stop", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Failure ownership", "direct", "main", true, "copilot");
    await service.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "full", provider: "copilot", model: "gpt-4.1" });
    const request = requireValue(sent, "Expected Copilot dispatch");
    const failure = requireValue(reportFailure, "Expected Copilot delivery handler");
    const runtime = requireValue(workerRuntime, "Expected owned runtime");
    const fence = runtime.providerEvents.fence.bind(runtime.providerEvents);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(runtime.providerEvents, "fence").mockImplementationOnce(async (execution) => { await fence(execution); await held; });
    const recover = vi.spyOn(runtime, "recoverRejected");
    const stop = vi.spyOn(runtime.owner, "stop");
    const files = container.resolve(ExecutionFileEvidenceCoordinator);
    const sealing = vi.spyOn(files, "seal");
    const failed = failure({ threadId: request.threadId, turnId: request.turnId,
      executionId: request.turnExecutionId, deliveryAttempt: 1 }, new Error("Canonical event execution is no longer admitted"));
    const stopped = service.stopSession(thread.id);
    release();
    await failed;
    const result = await stopped;
    expect(result).toMatchObject({ status: "already-terminal", snapshot: {
      threadId: thread.id, turnExecutionId: request.turnExecutionId, phase: "errored" } });
    expect(sealing.mock.calls.map(([input]) => input.outcome)).toEqual(["errored"]);
    expect(stop).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(service.runtimeAccess().activeCount()).toBe(0);
    expect(runtime.owner.current(thread.id)).toBeUndefined();
    await waitFor(() => canonicalPayloadTypes(thread.id).includes("turn.errored"));
    expect(database?.query("SELECT status FROM canonical_agent_turns WHERE execution_id=?").get(request.turnExecutionId)).toEqual({ status: "Errored" });
    expect(canonicalPayloadTypes(thread.id).filter((type) => ["turn.completed", "turn.cancelled", "turn.errored", "turn.interrupted"].includes(type))).toEqual(["turn.errored"]);
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
    const workspace = await container.resolve(WorkspaceRepo).create("worker-concurrent", temporaryDirectory!);
    const threads = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      container.resolve(ThreadRepo).create(workspace.id, `Concurrent ${index}`, "direct", "main", true, "codex")));
    const service = container.resolve(AgentService);

    await Promise.all(threads.map((thread) => service.sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" })));
    await waitFor(() => threads.every((thread) => workerRuntime?.owner.current(thread.id) === undefined));

    expect(published.filter((event) => event.type === "turnStarted")).toHaveLength(7);
    expect(threads.every((thread) => container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase === "completed")).toBe(true);
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
  });

  it("drops an optional rejected event and keeps its turn running until native completion", async () => {
    let sent: TurnRequest | undefined;
    let dropped: WorkerOwnedProviderEventResult | undefined;
    const runtime = requireValue(workerRuntime, "Expected worker runtime");
    const provider = fakeCodexProvider(async (request) => {
      sent = request;
      dropped = await submitCodexEvent(runtime, request, 1, { type: "turnStarted",
        threadId: request.threadId, turnExecutionId: request.turnExecutionId });
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-optional-rejected", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Dropped observation", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    const request = requireValue(sent, "Expected provider dispatch");
    expect(dropped).toMatchObject({ commit: { outcome: "dropped", reason: "projection-rejected" }, providerEvents: [] });
    expect(runtime.owner.current(thread.id)?.execution.executionId).toBe(request.turnExecutionId);
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("running");
    expect(runtime.scheduler.depth().activeExecutions).toBe(1);

    await submitCodexEvent(runtime, request, 2, { type: "turnComplete", threadId: thread.id,
      turnExecutionId: request.turnExecutionId, providerId: "codex", reason: "end_turn",
      costUsd: null, tokensIn: 1, tokensOut: 1 });
    await submitCodexEvent(runtime, request, 3, { type: "ended", threadId: thread.id,
      turnExecutionId: request.turnExecutionId });
    await waitFor(() => runtime.owner.current(thread.id) === undefined);
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)?.phase).toBe("completed");
    expect(runtime.scheduler.depth().activeExecutions).toBe(0);
    await waitFor(() => canonicalPayloadTypes(thread.id).includes("turn.completed"));
    expect(canonicalPayloadTypes(thread.id).filter((type) => ["turn.completed", "turn.cancelled", "turn.errored", "turn.interrupted"].includes(type)))
      .toEqual(["turn.completed"]);
  });

  it("interrupts and releases a rejected mandatory terminal whose ordinal cannot be replayed", async () => {
    let reportFailure: ((routing: { threadId: string; turnId: string;
      executionId: string; deliveryAttempt: number }, error: Error) => void | Promise<void>) | undefined;
    let rejected: Error | undefined;
    let sent: TurnRequest | undefined;
    const runtime = requireValue(workerRuntime, "Expected worker runtime");
    const recover = vi.spyOn(runtime, "recoverRejected");
    const provider = fakeCodexProvider(async (request) => {
      sent = request;
      await submitCodexEvent(runtime, request, 1, { type: "textDelta", threadId: request.threadId,
        turnExecutionId: request.turnExecutionId, delta: "Text without its required message boundary" });
      try {
        // A mandatory terminal with unclassified text is rejected after its mailbox ordinal is admitted.
        await submitCodexEvent(runtime, request, 2, { type: "error", threadId: request.threadId,
          turnExecutionId: request.turnExecutionId, error: "Native provider failure" });
      } catch (error) {
        if (!reportFailure || !(error instanceof Error)) throw error;
        rejected = error;
        await reportFailure({ threadId: request.threadId, turnId: request.turnId,
          executionId: request.turnExecutionId, deliveryAttempt: 1 }, error);
      }
    });
    Object.assign(provider, { setCanonicalTurnDeliveryFailureHandler: (handler: NonNullable<typeof reportFailure>) => {
      reportFailure = handler;
    } });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-rejected", temporaryDirectory!);
    const thread = await container.resolve(ThreadRepo).create(workspace.id, "Rejected event", "direct", "main", true, "codex");

    await container.resolve(AgentService).sendMessage({ threadId: thread.id,
      content: "hello", permissionMode: "default" });
    await waitFor(() => workerRuntime?.owner.current(thread.id) === undefined);

    const request = requireValue(sent, "Expected provider dispatch");
    expect(rejected?.message).toBe("Execution worker rejected command: invalid-event-routing");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith({ threadId: thread.id, turnId: request.turnId, executionId: request.turnExecutionId });
    expect(container.resolve(TurnRuntimeController).snapshot(thread.id)).toMatchObject({
      phase: "interrupted", turnExecutionId: request.turnExecutionId });
    expect(workerRuntime?.scheduler.depth().activeExecutions).toBe(0);
    await waitFor(() => canonicalPayloadTypes(thread.id).includes("turn.interrupted"));
    expect(canonicalPayloadTypes(thread.id).filter((type) => ["turn.completed", "turn.cancelled", "turn.errored", "turn.interrupted"].includes(type)))
      .toEqual(["turn.interrupted"]);
    expect(database?.query("SELECT status FROM canonical_agent_turns WHERE execution_id=?").get(request.turnExecutionId))
      .toEqual({ status: "Interrupted" });
  });

  it("releases a crashed execution while a peer remains runnable", async () => {
    const provider = fakeCodexProvider(async (request) => {
      void request;
    });
    registerFakeCodex(provider);
    const registry = container.resolve(AgentEventPublicationRegistry);
    registry.bind(() => undefined);
    registry.start();
    const workspace = await container.resolve(WorkspaceRepo).create("worker-crash", temporaryDirectory!);
    const threads = container.resolve(ThreadRepo);
    const lost = await threads.create(workspace.id, "Lost worker", "direct", "main", true, "codex");
    const peer = await threads.create(workspace.id, "Peer worker", "direct", "main", true, "codex");
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
      resolve: () => provider, resolveAll: () => [provider], shutdown: async () => undefined,
    });
    vi.spyOn(container.resolve(ProviderAvailabilityService), "assertUsable").mockReturnValue(undefined);
  }
});

function fakeCodexProvider(
  sendTurn: (request: TurnRequest) => Promise<void>,
  stopSession: (sessionId: string) => Promise<void> = async () => undefined,
): IAgentProvider {
  return Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const,
    descriptor: { id: "codex" as const, capabilities: [] },
    supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16000,
    forker: { fork: async () => { throw new Error("Session forks are outside this composition fixture"); } },
    sendTurn,
    stopSession,
    shutdown: () => undefined,
    listModels: async () => [],
    setCanonicalTurnEventDeliveryEnabled: () => undefined,
    setCanonicalTurnDeliveryFailureHandler: () => undefined,
    fenceCanonicalTurnEvents: async () => undefined,
    retireCanonicalTurnEvents: async () => undefined,
  });
}

async function submitCodexEvent(
  runtime: WorkerOwnedTurnRuntime,
  request: TurnRequest,
  sequence: number,
  event: AgentEvent,
): Promise<WorkerOwnedProviderEventResult> {
  const route = runtime.providerEvents.resolve(request.turnExecutionId, "codex");
  if (route.kind !== "worker") throw new Error("Codex turn did not bind its worker route");
  const itemId = `codex:${request.turnExecutionId}:item:${sequence}`;
  const eventId = `codex:${request.turnExecutionId}:event:${sequence}`;
  const timestamp = new Date().toISOString();
  return await route.submit({ threadId: request.threadId, turnId: request.turnId,
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



function canonicalProviderEvents(threadId: string): AgentEvent[] {
  return canonicalEnvelopes(threadId).flatMap((envelope) => {
    const item = envelope.payload?.item;
    const event = item?.payload?.projection === "providerRuntimeEvent" ? item.payload.runtimeEvent?.event : undefined;
    return event ? [event as AgentEvent] : [];
  });
}

function canonicalPayloadTypes(threadId: string): string[] {
  return canonicalEnvelopes(threadId).map((envelope) => envelope.payload?.type).filter((type): type is string => typeof type === "string");
}

function canonicalEnvelopes(threadId: string): Array<{ payload?: { type?: unknown; item?: { payload?: { projection?: unknown; runtimeEvent?: { event?: unknown } } } } }> {
  return (container.resolve<Database>("Database").query("SELECT envelope_json FROM canonical_agent_events WHERE thread_id=? ORDER BY accepted_sequence")
    .all(threadId) as Array<{ envelope_json: string }>)
    .map((row) => JSON.parse(row.envelope_json));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
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
