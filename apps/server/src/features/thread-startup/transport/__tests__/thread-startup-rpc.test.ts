import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStopResult, CanonicalAgentEventEnvelope, ThreadStartup, WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { createOwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { ThreadStartupRepo } from "../../persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../thread-startup-service.js";
import { StartupAgentPhaseObserver } from "../../startup-agent-phase-observer.js";
import { routeThreadStartupRpc } from "../thread-startup-rpc.js";

const startup: ThreadStartup = {
  startupId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-1",
  kind: "direct",
  state: "pending",
  phase: "thread",
  steps: [{ phase: "thread", state: "pending" }, { phase: "agent", state: "pending" }],
  transcript: [],
  cancellation: "none",
  revision: 1,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const stoppedSetup: WorkspaceEnvironmentAutomaticSetupSnapshot = {
  gate: "blocked", attempt: null, queuedTurns: [],
};
const databases: ReturnType<typeof createOwnedTestDatabase>[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

async function harness(kind: ThreadStartup["kind"], phase: ThreadStartup["phase"]) {
  const owned = createOwnedTestDatabase();
  databases.push(owned);
  owned.db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, ?)").run(
    startup.workspaceId, "Fixture", "/fixture", "{}",
  );
  const service = new ThreadStartupService(new ThreadStartupRepo(owned.db, owned.writer), owned.writer);
  const initial = await service.start({
    startupId: startup.startupId, workspaceId: startup.workspaceId, kind,
    ...(phase === "fetch" ? { fetch: { ref: "origin/main" } } : {}),
  });
  await service.advance(startup.startupId, "thread");
  const thread = await service.createAndBindThread(startup.startupId, {
    args: [startup.workspaceId, "Fixture", kind === "direct" ? "direct" : "worktree", "main", false, "codex", undefined, undefined, undefined],
  });
  for (const step of initial.steps.slice(1)) {
    if (service.get(startup.startupId)?.phase === phase) break;
    await service.advance(startup.startupId, step.phase);
  }
  const stopSession = vi.fn(async (): Promise<AgentStopResult> => ({
    threadId: thread.id, turnExecutionId: "execution-1",
    status: "cancelled", dispatchState: "dispatched",
    snapshot: { threadId: thread.id, turnExecutionId: "execution-1", phase: "cancelled" },
  }));
  const stopAutomaticSetup = vi.fn(async () => stoppedSetup);
  const deps = {
    threadStartupService: service,
    workspaceEnvironmentService: { stopAutomaticSetup },
    agentService: { stopSession },
  };
  const cancel = () => routeThreadStartupRpc("thread.startup.cancel", { startupId: startup.startupId }, deps);
  return { service, thread, stopSession, stopAutomaticSetup, cancel };
}

const intentCases = [
  ["direct", "thread"], ["direct", "fetch"],
  ["managed-worktree", "thread"], ["managed-worktree", "fetch"], ["managed-worktree", "worktree"],
  ["attached-worktree", "thread"], ["attached-worktree", "worktree"],
  ["pull-request-review", "thread"], ["pull-request-review", "worktree"],
] as const;
const agentKinds = ["direct", "managed-worktree", "attached-worktree", "pull-request-review"] as const;

describe("thread startup RPC", () => {
  it("routes get, list, and cancellation intent through the typed WebSocket router", async () => {
    const get = vi.fn(() => startup);
    const list = vi.fn(() => [startup]);
    const cancel = vi.fn(async () => ({ ...startup, cancellation: "requested" as const, revision: 2 }));
    const deps = { threadStartupService: { get, list, cancel } } as unknown as RouterDeps;

    const getResponse = await routeMessage(JSON.stringify({
      id: "get",
      method: "thread.startup.get",
      params: { startupId: startup.startupId },
    }), deps);
    const listResponse = await routeMessage(JSON.stringify({
      id: "list",
      method: "thread.startup.list",
      params: { workspaceId: startup.workspaceId },
    }), deps);
    const cancelResponse = await routeMessage(JSON.stringify({
      id: "cancel",
      method: "thread.startup.cancel",
      params: { startupId: startup.startupId },
    }), deps);

    expect(getResponse).toEqual({ id: "get", result: startup });
    expect(listResponse).toEqual({ id: "list", result: { records: [startup] } });
    expect(cancelResponse).toMatchObject({
      id: "cancel",
      result: { cancellation: "requested", revision: 2 },
    });
    expect(get).toHaveBeenCalledWith(startup.startupId);
    expect(list).toHaveBeenCalledWith(startup.workspaceId);
    expect(cancel).toHaveBeenCalledWith(startup.startupId);
  });


  it.each(intentCases)("records intent for %s / %s and leaves containment to the coordinator", async (kind, phase) => {
    const { service, cancel, stopSession, stopAutomaticSetup } = await harness(kind, phase);
    const result = await cancel();
    expect(result).toMatchObject({ kind, phase, state: "running", cancellation: "requested" });
    expect(service.get(startup.startupId)).toEqual(result);
    expect(await cancel()).toEqual(result);
    expect(stopSession).not.toHaveBeenCalled();
    expect(stopAutomaticSetup).not.toHaveBeenCalled();
  });

  it.each(["managed-worktree", "attached-worktree"] as const)("contains %s setup before cancelling, and a second cancel is harmless", async (kind) => {
    const { service, thread, cancel, stopSession, stopAutomaticSetup } = await harness(kind, "setup");
    let release: (() => void) | undefined;
    const contained = new Promise<void>((resolve) => { release = resolve; });
    stopAutomaticSetup.mockImplementation(async () => {
      await contained;
      return stoppedSetup;
    });
    const cancelling = cancel();
    await vi.waitFor(() => expect(stopAutomaticSetup).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id }));
    expect(service.get(startup.startupId)).toMatchObject({ state: "running", cancellation: "requested" });
    release?.();
    const result = await cancelling;
    expect(result).toMatchObject({ state: "cancelled", cancellation: "requested" });
    expect(await cancel()).toEqual(result);
    expect(stopAutomaticSetup).toHaveBeenCalledTimes(1);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it.each(agentKinds)("stops the %s agent and leaves the active turn outcome to the observer", async (kind) => {
    const { service, thread, cancel, stopSession, stopAutomaticSetup } = await harness(kind, "agent");
    let publish: ((events: readonly CanonicalAgentEventEnvelope[]) => void) | undefined;
    const observer = new StartupAgentPhaseObserver(service, (listener) => {
      publish = listener;
      return () => { publish = undefined; };
    });
    observer.start();
    stopSession.mockImplementation(async () => {
      expect(service.get(startup.startupId)?.cancellation).toBe("requested");
      return {
        threadId: thread.id, turnExecutionId: "execution-1", status: "cancelled", dispatchState: "dispatched",
        snapshot: { threadId: thread.id, turnExecutionId: "execution-1", phase: "cancelled" },
      };
    });
    expect(await cancel()).toMatchObject({ state: "running", phase: "agent", cancellation: "requested" });
    publish?.([{
      eventId: "cancelled-event",
      routing: { threadId: thread.id, turnId: "turn-1", executionId: "execution-1" },
      sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 1, durableRevision: 1,
      serverTimestamps: { acceptedAt: startup.createdAt, persistedAt: startup.createdAt },
      payload: { type: "turn.cancelled", endedAt: startup.createdAt, reason: "User stopped" },
    }]);
    await observer.stop();
    const cancelled = service.get(startup.startupId);
    expect(cancelled).toMatchObject({ state: "cancelled", cancellation: "requested" });
    expect(await cancel()).toEqual(cancelled);
    expect(stopSession).toHaveBeenCalledExactlyOnceWith(thread.id);
    expect(stopAutomaticSetup).not.toHaveBeenCalled();
  });

  it.each(agentKinds)("settles %s agent cancellation immediately when admission has not created a turn", async (kind) => {
    const { thread, cancel, stopSession, stopAutomaticSetup } = await harness(kind, "agent");
    stopSession.mockResolvedValue({
      threadId: thread.id, turnExecutionId: null, status: "already-terminal", dispatchState: "not-dispatched",
      snapshot: { threadId: thread.id, turnExecutionId: null, phase: "idle" },
    });
    const result = await cancel();
    expect(result).toMatchObject({ state: "cancelled", phase: "agent", cancellation: "requested" });
    expect(await cancel()).toEqual(result);
    expect(stopSession).toHaveBeenCalledExactlyOnceWith(thread.id);
    expect(stopAutomaticSetup).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)("returns a %s startup unchanged", async (state) => {
    const { service, cancel, stopSession, stopAutomaticSetup } = await harness("managed-worktree", "agent");
    switch (state) {
      case "completed": await service.complete(startup.startupId); break;
      case "failed": await service.fail(startup.startupId, { code: "AGENT_START_FAILED", message: "Failed", retryable: true }); break;
      case "cancelled": await service.markCancelled(startup.startupId); break;
      case "interrupted": await service.interruptNonterminalOnStartup(); break;
    }
    const terminal = service.get(startup.startupId);
    expect(await cancel()).toEqual(terminal);
    expect(await cancel()).toEqual(terminal);
    expect(stopSession).not.toHaveBeenCalled();
    expect(stopAutomaticSetup).not.toHaveBeenCalled();
  });

  it.each(["managed-worktree", "attached-worktree"] as const)("keeps %s nonterminal when setup containment fails", async (kind) => {
    const { service, cancel, stopAutomaticSetup } = await harness(kind, "setup");
    const failure = new Error("containment failed");
    stopAutomaticSetup.mockRejectedValue(failure);
    await expect(cancel()).rejects.toBe(failure);
    expect(service.get(startup.startupId)).toMatchObject({ state: "running", phase: "setup", cancellation: "requested" });
  });

  it("keeps the startup nonterminal when stopping the agent fails", async () => {
    const { service, cancel, stopSession } = await harness("direct", "agent");
    const failure = new Error("stop failed");
    stopSession.mockRejectedValue(failure);
    await expect(cancel()).rejects.toBe(failure);
    expect(service.get(startup.startupId)).toMatchObject({ state: "running", phase: "agent", cancellation: "requested" });
  });
});
