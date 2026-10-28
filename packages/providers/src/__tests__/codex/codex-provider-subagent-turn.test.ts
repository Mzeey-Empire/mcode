import { fixtureExecutionId } from "./codex-provider-test-fixture.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@mcode/shared", () => ({
  logger: { warn: loggerWarnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../private/codex/codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
}));

vi.mock("../../version-policy.js", () => ({ meetsMinVersion: () => true }));

const { sendTurnMock, getChildThreadMetadataMock, interruptChildTurnMock } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("native-main-turn"),
  getChildThreadMetadataMock: vi.fn().mockResolvedValue({
    identity: "read_docs_worker",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    parentMessage: "Inspect the delegated task.",
  }),
  interruptChildTurnMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../private/codex/codex-app-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    async start(): Promise<void> {}
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string | null> {
      return sendTurnMock(input, turnOptions);
    }
    async getChildThreadMetadata(childThreadId: string): Promise<{
      identity?: string;
      model: string;
      reasoningEffort: string;
      parentMessage?: string;
    }> {
      return getChildThreadMetadataMock(childThreadId);
    }
    async interruptTurn(): Promise<void> {}
    async interruptChildTurn(nativeThreadId: string, nativeTurnId: string): Promise<void> {
      await interruptChildTurnMock(nativeThreadId, nativeTurnId);
    }
    async kill(): Promise<void> {}
  }
  return { CodexAppServer: MockCodexAppServer };
});

import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { ProviderFileMutationStart } from "@mcode/contracts/providers/interfaces";
import type { ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";

interface PoolEntry {
  pendingTurnId: string | null;
  server: { emit: (event: string, payload: unknown) => void };
  mapper: { prepareForTurn: () => void };
}

/** Spawns a provider session and returns its pool entry once the first turn was sent. */
async function startSession(
  provider: CodexProvider,
  sessionId: string,
  threadId: string,
  executionId = fixtureExecutionId(sessionId),
): Promise<PoolEntry> {
  await provider.sendTurn({
    turnId: "test-turn",
    turnExecutionId: executionId,
    sessionId,
    workspaceId: "workspace-test",
    threadId,
    message: "hey",
    cwd: process.cwd(),
    model: "gpt-5.4",
    interactionMode: "build",
    providerOptions: {},
    permissionMode: "auto",
  });

  for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

    await provider.flushCanonicalEvents();
    expect(sendTurnMock).toHaveBeenCalled();

  const pool = (
    provider as unknown as {
      runtime: { get: (id: string) => PoolEntry | undefined };
    }
  ).runtime;
  const entry = pool.get(sessionId);

    await provider.flushCanonicalEvents();
    expect(entry).toBeDefined();
  return entry!;
}

const providers: CodexProvider[] = [];

function makeProvider(): CodexProvider {
  const provider = new CodexProvider(
    { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
    stubEnvService() as never,
    { persistGeneratedImageFromPath: vi.fn(() => ({ id: "generated-image", name: "image.png", mimeType: "image/png", sizeBytes: 4 })) } as never,
    {
      currentSkills: vi.fn(() => []),
      listModels: vi.fn(async () => []),
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh: vi.fn(async () => ({ skills: [] })),
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as never,
  );
  providers.push(provider);
  return provider;
}

/**
 * Regression: Codex sub-agent (collab receiver) threads stream their own
 * turn/started + turn/completed over the same app-server connection. The
 * provider's turn bookkeeping must only react to main-thread lifecycle
 * notifications — otherwise a finishing sub-agent resolves the main runTurn
 * wait, emits Ended mid-turn, and the UI drops the running indicator while
 * narration keeps streaming (and the still-busy session becomes evictable).
 */
describe("CodexProvider sub-agent turn lifecycle isolation", () => {
  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.shutdown();
  });
  beforeEach(() => {
    sendTurnMock.mockReset().mockResolvedValue("native-main-turn");
    getChildThreadMetadataMock.mockClear();
    interruptChildTurnMock.mockClear();
    loggerWarnMock.mockClear();
  });

  it("binds a private early child file mutation only to a known native turn and retry attempt", async () => {
    const provider = makeProvider();
    const mutations: ProviderFileMutationStart[] = [];
    provider.on("file_mutation_start", (event: ProviderFileMutationStart) => mutations.push(event));
    const entry = await startSession(provider, "mcode-file-attempt", "file-attempt");
    const state = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      turnDeliveryAttemptsByNativeTurn: Map<string, number>;
      nativeExecutionConflictKeys: Set<string>;
      turnDiffRouting?: { turnId: string; turnExecutionId: string; deliveryAttempt: number };
    };
    state.turnExecutionIdsByNativeTurn.set("bound-native", "7ec4dc86-bd75-49d9-8019-1680eb92b8bc");
    state.turnDeliveryAttemptsByNativeTurn.set("bound-native", 1);
    state.turnDiffRouting = { turnId: "test-turn", turnExecutionId: "7ec4dc86-bd75-49d9-8019-1680eb92b8bc", deliveryAttempt: 2 };
    const item = { type: "fileChange", id: "edit", changes: [{ path: "tracked.txt", kind: "edit" }] };

    entry.server.emit("notification", { method: "item/started",
      params: { threadId: "early-child", turnId: "old-native", item } });

    entry.server.emit("notification", { method: "item/started",
      params: { threadId: "early-child", turnId: "bound-native", item: { ...item, id: "edit-current" } } });

    await provider.flushCanonicalEvents();
    expect(mutations).toHaveLength(2);

    await provider.flushCanonicalEvents();
    expect(mutations[0]).toMatchObject({ toolCallId: "edit" });

    await provider.flushCanonicalEvents();
    expect(mutations[0]?.turnExecutionId).toBeUndefined();

    await provider.flushCanonicalEvents();
    expect(mutations[0]?.deliveryAttempt).toBeUndefined();

    await provider.flushCanonicalEvents();
    expect(mutations[1]).toMatchObject({
      toolCallId: "edit-current", turnExecutionId: "7ec4dc86-bd75-49d9-8019-1680eb92b8bc", deliveryAttempt: 1,
    });
    state.nativeExecutionConflictKeys.add("bound-native");
    entry.server.emit("notification", { method: "item/started",
      params: { threadId: "early-child", turnId: "bound-native", item: { ...item, id: "edit-conflicted" } } });

    await provider.flushCanonicalEvents();
    expect(mutations[2]?.deliveryAttempt).toBeUndefined();
  });

  it("assigns the active execution to main tool and text events before turn/start binds", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-early-main", "early-main", "fdb68c9c-9f8a-4dc0-82e0-5876508522ed");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      nextTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      turnStartResponsePending: boolean;
      currentNativeTurnId?: string;
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "fdb68c9c-9f8a-4dc0-82e0-5876508522ed";
    state.activeParentTurnExecutionId = "fdb68c9c-9f8a-4dc0-82e0-5876508522ed";
    state.nextTurnExecutionId = "fdb68c9c-9f8a-4dc0-82e0-5876508522ed";
    state.turnBindingPhase = "awaiting";
    state.turnStartResponsePending = true;
    state.currentNativeTurnId = undefined;

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "early-native-turn",
        item: { type: "commandExecution", id: "early-tool", command: "echo early" },
      },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "early-native-turn", delta: "early text" },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "early-native-turn", status: "completed", usage: {} },
      },
    });

    await provider.flushCanonicalEvents();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: AgentEventType.ToolUse, toolCallId: "early-tool", turnExecutionId: "fdb68c9c-9f8a-4dc0-82e0-5876508522ed" }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: AgentEventType.TextDelta, delta: "early text", turnExecutionId: "fdb68c9c-9f8a-4dc0-82e0-5876508522ed" }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: AgentEventType.TurnComplete, turnExecutionId: "fdb68c9c-9f8a-4dc0-82e0-5876508522ed" }) }),
    ]));
  });

  it("resolves an early main completion after turn/start returns its native id", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    let resolveNativeTurn!: (turnId: string) => void;
    sendTurnMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveNativeTurn = resolve;
    }));

    const sessionId = "mcode-early-completion";
    const completion = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "87b18f2d-a2e6-4726-8d5a-5b841d720e76",
      sessionId,
      workspaceId: "workspace-test",
      threadId: "early-completion",
      message: "hey",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    let entry: PoolEntry | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      entry = (
        provider as unknown as {
          runtime: { get: (id: string) => PoolEntry | undefined };
        }
      ).runtime.get(sessionId);
      if (!entry) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    await provider.flushCanonicalEvents();
    expect(entry).toBeDefined();
    for (let i = 0; i < 20 && !resolveNativeTurn; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await provider.flushCanonicalEvents();
    expect(resolveNativeTurn).toEqual(expect.any(Function));

    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "early-native-turn", status: "completed", usage: {} },
      },
    });

    resolveNativeTurn("early-native-turn");

    await expect(completion).resolves.toBeUndefined();

    await provider.flushCanonicalEvents();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: AgentEventType.TurnComplete, turnExecutionId: "87b18f2d-a2e6-4726-8d5a-5b841d720e76" }) }),
    ]));
  });

  it("settles the root turn by native identity after a child thread id churn", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    sendTurnMock.mockResolvedValueOnce("root-native-turn");

    const completion = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "04651f7d-240a-40a8-8561-edcefaa7b83b",
      sessionId: "mcode-root-child-churn",
      workspaceId: "workspace-test",
      threadId: "root-child-churn",
      message: "delegate and summarize",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    let entry: PoolEntry | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      entry = (
        provider as unknown as {
          runtime: { get: (id: string) => PoolEntry | undefined };
        }
      ).runtime.get("mcode-root-child-churn");
      if (!entry) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await provider.flushCanonicalEvents();
    expect(entry).toBeDefined();
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await provider.flushCanonicalEvents();
    expect(sendTurnMock).toHaveBeenCalled();

    // A child thread/started notification without parentThreadId can churn the
    // app-server's mutable thread id while the root turn remains in flight.
    (entry!.server as unknown as { threadId: string }).threadId = "child-native-thread";
    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "child-native-thread",
        turn: { id: "child-native-turn", status: "completed" },
      },
    });

    entry!.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "root-native-turn", delta: "root final" },
    });

    entry!.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "root-native-turn",
        item: { type: "agentMessage", id: "root-message" },
      },
    });

    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "root-native-turn", status: "completed", usage: {} },
      },
    });


    await expect(completion).resolves.toBeUndefined();

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnComplete)).toHaveLength(1);

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toHaveLength(1);

    await provider.flushCanonicalEvents();
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Message)?.event).toMatchObject({
      content: "root final",
    });
  });

  it("buffers ambiguous child events, replays after native mapping, and stays bounded", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-buffer", "child-buffer", "4bdd2783-2837-44a1-87e2-bf624bba01ae");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      currentNativeTurnId?: string;
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
      childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
      pendingChildEvents: unknown[];
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "4bdd2783-2837-44a1-87e2-bf624bba01ae";
    state.activeParentTurnExecutionId = "4bdd2783-2837-44a1-87e2-bf624bba01ae";
    state.turnBindingPhase = "bound";
    state.currentNativeTurnId = "main-native-turn";
    state.turnExecutionIdsByNativeTurn.set("main-native-turn", "4bdd2783-2837-44a1-87e2-bf624bba01ae");
    state.childExecutionGenerations.set("child-buffered", { executionId: "4bdd2783-2837-44a1-87e2-bf624bba01ae", generation: 1 });
    state.nativeThreadExecutionIds.set("child-buffered", "4bdd2783-2837-44a1-87e2-bf624bba01ae");
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "collabAgentToolCall",
          id: "agent-child",
          tool: "spawnAgent",
          receiverThreadIds: ["child-buffered"],
        },
      },
    });

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-buffered",
        turnId: "child-native-turn",
        item: { type: "commandExecution", id: "child-tool", command: "echo child" },
      },
    });

    await provider.flushCanonicalEvents();
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse && runtimeEvent.event.toolCallId === "child-tool")).toBeUndefined();

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-buffered", turn: { id: "child-native-turn" } },
    });

    await provider.flushCanonicalEvents();
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: AgentEventType.ToolUse,
      toolCallId: "child-tool",
      turnExecutionId: "4bdd2783-2837-44a1-87e2-bf624bba01ae",
    }) }));
    await provider.flushCanonicalEvents();
    const childToolEvents = events.filter((runtimeEvent) => (
      runtimeEvent.event.type === AgentEventType.ToolUse && runtimeEvent.event.toolCallId === "child-tool"
    ));

    await provider.flushCanonicalEvents();
    expect(childToolEvents).toHaveLength(1);
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-buffered",
        turnId: "child-native-turn",
        item: { type: "commandExecution", id: "child-tool", command: "echo child" },
      },
    });

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => (
      runtimeEvent.event.type === AgentEventType.ToolUse && runtimeEvent.event.toolCallId === "child-tool"
    ))).toHaveLength(1);

    for (let i = 0; i < 140; i++) {
      entry.server.emit("notification", {
        method: "item/started",
        params: {
          threadId: "child-buffered",
          turnId: `unbound-child-turn-${i}`,
          item: { type: "commandExecution", id: `child-tool-${i}`, command: "echo child" },
        },
      });

    }

    await provider.flushCanonicalEvents();
    expect(state.pendingChildEvents).toHaveLength(128);
  });

  it("delivers every child assistant delta and its completed message once", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-assistant-stream", "child-assistant-stream", "1bee6da6-5955-40fc-8a67-a0f13e6e1949");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      currentNativeTurnId?: string;
      turnExecutionIdsByNativeTurn: Map<string, string>;
      childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "1bee6da6-5955-40fc-8a67-a0f13e6e1949";
    state.activeParentTurnExecutionId = "1bee6da6-5955-40fc-8a67-a0f13e6e1949";
    state.turnBindingPhase = "bound";
    state.currentNativeTurnId = "main-native-turn";
    state.turnExecutionIdsByNativeTurn.set("main-native-turn", state.currentTurnExecutionId);

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "collabAgentToolCall",
          id: "agent-assistant-stream",
          tool: "spawnAgent",
          receiverThreadIds: ["child-assistant-stream"],
        },
      },
    });

    state.childExecutionGenerations.set("child-assistant-stream", { executionId: state.currentTurnExecutionId, generation: 1 });
    state.nativeThreadExecutionIds.set("child-assistant-stream", state.currentTurnExecutionId);
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-assistant-stream", turn: { id: "child-native-turn" } },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "child-assistant-stream", turnId: "child-native-turn", itemId: "child-message", delta: "A" },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "child-assistant-stream", turnId: "child-native-turn", itemId: "child-message", delta: "A" },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-assistant-stream",
        turnId: "child-native-turn",
        item: { type: "agentMessage", id: "child-message", content: [{ type: "output_text", text: "AA" }] },
      },
    });


    await provider.flushCanonicalEvents();
    const childEvents = events.filter((event) => event.extension?.child?.nativeThreadId === "child-assistant-stream");
    const deltas = childEvents.filter((event) => event.event.type === AgentEventType.TextDelta);

    await provider.flushCanonicalEvents();
    expect(deltas.map((event) => event.event.delta)).toEqual(["A", "A"]);

    await provider.flushCanonicalEvents();
    expect(new Set(deltas.map((event) => event.extension?.child?.nativeEventId)).size).toBe(2);

    await provider.flushCanonicalEvents();
    expect(childEvents).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: AgentEventType.Message, content: "AA" }),
      extension: expect.objectContaining({ child: expect.objectContaining({ itemEventKey: "stream-complete" }) }),
    }));
  });

  it("replays mapper and provider child buffers in structural order exactly once", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-two-layer-replay", "child-two-layer-replay", "aa4f59f8-b68b-4939-85e0-3c4cfa559583");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      currentNativeTurnId?: string;
      turnExecutionIdsByNativeTurn: Map<string, string>;
      turnDeliveryAttemptsByNativeTurn: Map<string, number>;
      turnDiffRouting?: { turnId: string; turnExecutionId: string; deliveryAttempt: number };
      childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
      nativeThreadExecutionIds: Map<string, string>;
      pendingChildEvents: unknown[];
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "aa4f59f8-b68b-4939-85e0-3c4cfa559583";
    state.activeParentTurnExecutionId = "aa4f59f8-b68b-4939-85e0-3c4cfa559583";
    state.turnBindingPhase = "bound";
    state.currentNativeTurnId = "main-native-turn";
    state.turnExecutionIdsByNativeTurn.set("main-native-turn", state.currentTurnExecutionId);
    state.turnDeliveryAttemptsByNativeTurn.set("main-native-turn", 2);
    state.turnDiffRouting = { turnId: "test-turn", turnExecutionId: state.currentTurnExecutionId, deliveryAttempt: 2 };

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "collabAgentToolCall",
          id: "agent-two-layer",
          tool: "spawnAgent",
          receiverThreadIds: ["child-two-layer"],
        },
      },
    });

    state.activeParentTurnExecutionId = undefined;
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-two-layer",
        item: { type: "commandExecution", id: "child-two-layer-item", command: "echo child" },
      },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-two-layer",
        item: {
          type: "commandExecution",
          id: "child-two-layer-item",
          command: "echo child",
          aggregatedOutput: "child output",
          exitCode: 0,
        },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-two-layer", turn: { id: "child-two-layer-turn" } },
    });

    await provider.flushCanonicalEvents();
    expect(state.pendingChildEvents).toHaveLength(3);

    state.activeParentTurnExecutionId = state.currentTurnExecutionId;
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "subAgentActivity",
          id: "subagent-two-layer",
          kind: "started",
          agentThreadId: "child-two-layer",
          agentPath: "agents/child-two-layer",
        },
      },
    });


    await provider.flushCanonicalEvents();
    const childEvents = events.filter((runtimeEvent) => (
      runtimeEvent.extension?.child?.nativeThreadId === "child-two-layer"
    ));

    await provider.flushCanonicalEvents();
    expect(childEvents.map((runtimeEvent) => runtimeEvent.event.type)).toEqual([
      AgentEventType.TurnStarted,
      AgentEventType.ToolUse,
      AgentEventType.ToolResult,
    ]);

    await provider.flushCanonicalEvents();
    expect(childEvents.map((runtimeEvent) => (
      runtimeEvent.event.type === AgentEventType.ToolUse || runtimeEvent.event.type === AgentEventType.ToolResult
        ? runtimeEvent.event.toolCallId
        : runtimeEvent.event.type
    ))).toEqual([
      AgentEventType.TurnStarted,
      "child-two-layer-item",
      "child-two-layer-item",
    ]);

    await provider.flushCanonicalEvents();
    expect(childEvents).toHaveLength(3);

    await provider.flushCanonicalEvents();
    expect(childEvents.every((runtimeEvent) => runtimeEvent.deliveryAttempt === 1)).toBe(true);

    await provider.flushCanonicalEvents();
    expect(childEvents.every((runtimeEvent) => (
      runtimeEvent.event.turnExecutionId
        === "aa4f59f8-b68b-4939-85e0-3c4cfa559583"
    ))).toBe(true);
    const childEventIds = childEvents.map((runtimeEvent) => runtimeEvent.extension?.child?.nativeEventId);

    await provider.flushCanonicalEvents();
    expect(childEventIds.every((id): id is string => Boolean(id))).toBe(true);

    await provider.flushCanonicalEvents();
    expect(new Set(childEventIds).size).toBe(3);

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-two-layer",
        item: {
          type: "commandExecution",
          id: "child-two-layer-item",
          command: "echo child",
          aggregatedOutput: "child output",
          exitCode: 0,
        },
      },
    });

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => (
      runtimeEvent.extension?.child?.nativeThreadId === "child-two-layer"
    ))).toHaveLength(3);
  });

  it("enriches nested native sub-agents from one authoritative child lookup each", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-metadata", "subagent-metadata");

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-outer",
          kind: "started",
          agentThreadId: "child-outer",
          agentPath: "/root/explorer",
        },
      },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-outer",
        item: {
          type: "subAgentActivity",
          id: "call-inner",
          kind: "started",
          agentThreadId: "child-inner",
          agentPath: "/root/implementer",
        },
      },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-outer",
        item: {
          type: "subAgentActivity",
          id: "call-inner",
          kind: "started",
          agentThreadId: "child-inner",
          agentPath: "/root/implementer",
        },
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
    await provider.flushCanonicalEvents();
    const nestedUpdate = events.find((runtimeEvent) => (
      runtimeEvent.event.type === AgentEventType.ToolUse && runtimeEvent.event.toolCallId === "call-inner"
    ));

    await provider.flushCanonicalEvents();
    expect(nestedUpdate?.event).toMatchObject({
      type: AgentEventType.ToolUse,
      toolCallId: "call-inner",
      parentToolCallId: "call-outer",
      toolInput: { description: "Inspect the delegated task." },
    });

    await provider.flushCanonicalEvents();
    expect(nestedUpdate?.extension).toMatchObject({
      collaboration: expect.objectContaining({
        agentName: "read_docs_worker",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        prompt: "Inspect the delegated task.",
      }),
    });
  });

  it("enriches a Codex collab spawn from its receiver thread", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-collab-metadata", "collab-metadata");

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "collabAgentToolCall",
          id: "call-collab-metadata",
          tool: "spawnAgent",
          receiverThreadIds: ["child-collab-metadata"],
        },
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledWith("child-collab-metadata");
    await provider.flushCanonicalEvents();
    const collabUpdate = events.find((runtimeEvent) => (
      runtimeEvent.event.type === AgentEventType.ToolUse
      && runtimeEvent.event.toolCallId === "call-collab-metadata"
      && runtimeEvent.extension?.collaboration?.agentName === "read_docs_worker"
    ));

    await provider.flushCanonicalEvents();
    expect(collabUpdate?.event).toMatchObject({
      type: AgentEventType.ToolUse,
      toolCallId: "call-collab-metadata",
    });

    await provider.flushCanonicalEvents();
    expect(collabUpdate?.extension).toMatchObject({
      collaboration: expect.objectContaining({
        agentName: "read_docs_worker",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      }),
    });
  });

  it("retries child metadata until Codex publishes the display identity", async () => {
    getChildThreadMetadataMock
      .mockResolvedValueOnce({ model: "gpt-5.6-sol", reasoningEffort: "medium" })
      .mockResolvedValueOnce({
        identity: "Euclid",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-late-identity", "subagent-late-identity");

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-late-identity",
          kind: "started",
          agentThreadId: "child-late-identity",
          agentPath: "/root/worker",
        },
      },
    });


    await vi.waitFor(() => {
      expect(events.some((runtimeEvent) => (
        runtimeEvent.event.type === AgentEventType.ToolUse
        && runtimeEvent.event.toolCallId === "call-late-identity"
        && runtimeEvent.extension?.collaboration?.agentName === "Euclid"
      ))).toBe(true);
    });

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes a completed v2 child to capture its persisted parent task", async () => {
    getChildThreadMetadataMock
      .mockResolvedValueOnce({
        identity: "Euclid",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      })
      .mockResolvedValueOnce({
        identity: "Euclid",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      })
      .mockResolvedValueOnce({
        identity: "Euclid",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      })
      .mockResolvedValueOnce({
        identity: "Euclid",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-delayed-task", "subagent-delayed-task");

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-delayed-task",
          kind: "started",
          agentThreadId: "child-delayed-task",
          agentPath: "/root/worker",
        },
      },
    });

    await vi.waitFor(() => {
      expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(4);
    }, { timeout: 3_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    entry.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "child-delayed-task",
        turn: { id: "child-turn", status: "completed", usage: {} },
      },
    });


    await vi.waitFor(() => {
      expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(5);
    });
    await vi.waitFor(() => {
      const childResult = events.find((runtimeEvent) => (
        runtimeEvent.event.type === AgentEventType.ToolResult
        && runtimeEvent.event.toolCallId === "call-delayed-task"
      ));
      expect(childResult?.event).toMatchObject({
        type: "toolResult",
        toolCallId: "call-delayed-task",
        toolInput: { description: "Inspect the delegated task." },
      });
      expect(childResult?.extension).toMatchObject({
        collaboration: {
          agentName: "read_docs_worker",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          prompt: "Inspect the delegated task.",
        },
      });
    });
  });

  it("retries child metadata after an active-thread read race", async () => {
    getChildThreadMetadataMock
      .mockRejectedValueOnce(new Error("thread is not readable yet"))
      .mockResolvedValueOnce({ identity: "Dirac" });
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-read-race", "subagent-read-race");

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "collabAgentToolCall",
          id: "call-read-race",
          tool: "spawnAgent",
          receiverThreadIds: ["child-read-race"],
        },
      },
    });


    await vi.waitFor(() => {
      expect(events.some((runtimeEvent) => (
        runtimeEvent.event.type === AgentEventType.ToolUse
        && runtimeEvent.event.toolCallId === "call-read-race"
        && runtimeEvent.extension?.collaboration?.agentName === "Dirac"
      ))).toBe(true);
    });

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("bounds child metadata lookup dedupe to the active main turn", async () => {
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-subagent-metadata-reset", "subagent-metadata-reset");
    const childActivity = {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-repeat-child",
          kind: "started",
          agentThreadId: "child-repeat",
          agentPath: "/root/explorer",
        },
      },
    };

    entry.server.emit("notification", childActivity);

    await new Promise<void>((resolve) => setImmediate(resolve));
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-next" } },
    });

    entry.server.emit("notification", childActivity);

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("ignores stale metadata lookup results after a new main turn starts", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-old").mockResolvedValueOnce("turn-next");
    let resolveOldMetadata: ((value: { model: string; reasoningEffort: string }) => void) | undefined;
    getChildThreadMetadataMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldMetadata = resolve; }))
      .mockResolvedValueOnce({ model: "gpt-current", reasoningEffort: "high" });
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-metadata-race", "subagent-metadata-race");
    const oldActivity = {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-old-metadata",
          kind: "started",
          agentThreadId: "child-reused",
          agentPath: "/root/explorer",
        },
      },
    };

    entry.server.emit("notification", oldActivity);

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(1);

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "8ef3fa9c-edb9-4907-8d86-00a0a4514359",
      sessionId: "mcode-subagent-metadata-race",
      workspaceId: "workspace-test",
      threadId: "subagent-metadata-race",
      message: "next turn",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await provider.flushCanonicalEvents();
    expect(sendTurnMock).toHaveBeenCalledTimes(2);
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-next" } },
    });

    entry.server.emit("notification", {
      ...oldActivity,
      params: {
        ...oldActivity.params,
        item: { ...oldActivity.params.item, id: "call-current-metadata" },
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveOldMetadata?.({ model: "gpt-stale", reasoningEffort: "low" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    const currentMetadataEvents = events.filter((runtimeEvent) =>
      runtimeEvent.event.type === AgentEventType.ToolUse
      && runtimeEvent.event.toolCallId === "call-current-metadata"
      && runtimeEvent.extension?.collaboration?.model !== undefined,
    );

    await provider.flushCanonicalEvents();
    expect(currentMetadataEvents).toEqual([expect.objectContaining({ event: expect.objectContaining({
      toolInput: { description: "explorer" },
    })
    })]);

    await provider.flushCanonicalEvents();
    expect(currentMetadataEvents[0]?.extension).toMatchObject({
      collaboration: { model: "gpt-current", reasoningEffort: "high" },
    });
  });

  it("does not let a child-thread turn/started overwrite pendingTurnId", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-main");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-subagent-a", "subagent-a");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main" } },
    });

    await provider.flushCanonicalEvents();
    expect(entry.pendingTurnId).toBe("turn-main");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-thread-9", turn: { id: "turn-child" } },
    });

    await provider.flushCanonicalEvents();
    expect(entry.pendingTurnId).toBe("turn-main");
  });

  it("does not emit Ended when a child-thread turn completes mid main turn", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-main");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));

    const entry = await startSession(provider, "mcode-subagent-b", "subagent-b");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main" } },
    });


    // Child completion with its own turn id.
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-thread-9", turn: { id: "turn-child", status: "completed" } },
    });

    // Child completion without a turn id (shape observed from wait-less collabs).
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-thread-10", turn: { status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toHaveLength(0);

    await provider.flushCanonicalEvents();
    expect(entry.pendingTurnId).toBe("turn-main");

    const ended = new Promise<void>((resolve) => {
      provider.observeCanonicalEvents((runtimeEvent: ProviderRuntimeEvent) => {
        if (runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.threadId === "subagent-b") resolve();
      });
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main", status: "completed" } },
    });

    await ended;
  });

  it("attributes reused-session child notifications to the active execution", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-origin-a", "origin-a");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "A" },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-origin-a",
      workspaceId: "workspace-test",
      threadId: "origin-a",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-b", turn: { id: "child-turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-b",
        turnId: "child-turn-b",
        item: {
          type: "subAgentActivity",
          id: "call-child-b",
          kind: "started",
          agentThreadId: "child-b-nested",
          agentPath: "/root/worker",
        },
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.turnExecutionId === "c6239384-cf6e-4b69-809a-6d00ed0980c6")).toBe(true);
  });

  it("keeps known native A mappings immutable after B starts", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-origin-immutable", "origin-immutable");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: {
          type: "subAgentActivity",
          id: "call-child-a",
          kind: "started",
          agentThreadId: "child-a",
        },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-a", turn: { id: "child-turn-a" } },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-origin-immutable",
      workspaceId: "workspace-test",
      threadId: "origin-immutable",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await provider.flushCanonicalEvents();
    expect(sendTurnMock).toHaveBeenCalledTimes(2);
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    await new Promise<void>((resolve) => setImmediate(resolve));

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });


    // Replayed A lifecycle ids must not overwrite either native map or leak
    // completed main-turn text into B.
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "late A" },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-a", turn: { id: "child-turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "child-a", turnId: "child-turn-a", delta: "late child A" },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-a", turn: { id: "child-turn-a", status: "completed" } },
    });

    await provider.flushCanonicalEvents();
    expect(entry.pendingTurnId).toBe("turn-b");
    const nativeMaps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(nativeMaps.turnExecutionIdsByNativeTurn.get("turn-a")).toBe("b19d6e35-9407-4ac5-8794-8a3eabd2f2bd");

    await provider.flushCanonicalEvents();
    expect(nativeMaps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("b19d6e35-9407-4ac5-8794-8a3eabd2f2bd");

    await provider.flushCanonicalEvents();
    expect(nativeMaps.nativeThreadExecutionIds.get("child-a")).toBe("b19d6e35-9407-4ac5-8794-8a3eabd2f2bd");

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-b", delta: "B" },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b", status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    const lateA = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TextDelta && runtimeEvent.event.delta === "late A");
    await provider.flushCanonicalEvents();
    const bText = events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TextDelta && runtimeEvent.event.delta === "B");

    await provider.flushCanonicalEvents();
    expect(lateA).toEqual([]);

    await provider.flushCanonicalEvents();
    expect(bText?.event.turnExecutionId).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended).at(-1)?.event.turnExecutionId).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("does not settle B from late A completion before B binds", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-late-completion", "late-completion");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });


    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-late-completion",
      workspaceId: "workspace-test",
      threadId: "late-completion",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.turnExecutionId === "c6239384-cf6e-4b69-809a-6d00ed0980c6")).toBe(false);

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b", status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.turnExecutionId === "c6239384-cf6e-4b69-809a-6d00ed0980c6")).toBe(true);
  });

  it("does not rebind an evicted native A turn id from a late start", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-evicted-turn", "evicted-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-evicted-turn",
      workspaceId: "workspace-test",
      threadId: "evicted-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    for (let i = 0; i < 129; i++) {
      entry.server.emit("notification", {
        method: "turn/started",
        params: { threadId: `child-${i}`, turn: { id: `child-turn-${i}` } },
      });

    }
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.turnExecutionId === "c6239384-cf6e-4b69-809a-6d00ed0980c6")).toBe(false);
  });

  it("attributes parent notifications without turn ids to active B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-parent-no-turn", "parent-no-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-parent-no-turn",
      workspaceId: "workspace-test",
      threadId: "parent-no-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", delta: "B no turn id" },
    });

    await provider.flushCanonicalEvents();
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TextDelta && runtimeEvent.event.delta === "B no turn id")?.event.turnExecutionId).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("bounds repeated native mapping conflict diagnostics", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-conflict-bound", "conflict-bound");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-conflict-bound",
      workspaceId: "workspace-test",
      threadId: "conflict-bound",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    for (let i = 0; i < 200; i++) {
      entry.server.emit("notification", {
        method: "turn/started",
        params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
      });

    }

    await provider.flushCanonicalEvents();
    expect(loggerWarnMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("fails closed when turn/started precedes a null turn/start response", async () => {
    let resolveTurnStart: ((turnId: string | null) => void) | undefined;
    sendTurnMock.mockImplementationOnce(() => new Promise<string | null>((resolve) => {
      resolveTurnStart = resolve;
    }));
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-null-before", "null-before");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-before" } },
    });

    resolveTurnStart?.(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error && runtimeEvent.event.turnExecutionId === "f081a40d-d4c8-4902-840d-e52641d135bc")).toBe(true);

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.turnExecutionId === "f081a40d-d4c8-4902-840d-e52641d135bc")).toBe(true);

    await provider.flushCanonicalEvents();
    expect((entry as PoolEntry & { turnBindingPhase?: string }).turnBindingPhase).toBe("idle");
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-before", status: "completed" } },
    });

  });

  it("fails closed when turn/started follows a null turn/start response", async () => {
    sendTurnMock.mockResolvedValueOnce(null);
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-null-after", "null-after");

    await new Promise<void>((resolve) => setImmediate(resolve));
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-after" } },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error && runtimeEvent.event.turnExecutionId === "419b5013-06be-4a12-82c0-4d18a8a799aa")).toBe(true);

    await provider.flushCanonicalEvents();
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended && runtimeEvent.event.turnExecutionId === "419b5013-06be-4a12-82c0-4d18a8a799aa")).toBe(true);

    await provider.flushCanonicalEvents();
    expect((entry as PoolEntry & { turnBindingPhase?: string }).turnBindingPhase).toBe("idle");
  });

  it("drops text and tool events for a pruned A turn instead of falling back to B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-pruned-text", "pruned-text");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-pruned-text",
      workspaceId: "workspace-test",
      threadId: "pruned-text",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    for (let i = 0; i < 129; i++) {
      maps.turnExecutionIdsByNativeTurn.set(`filler-${i}`, "c6239384-cf6e-4b69-809a-6d00ed0980c6");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    maps.turnExecutionIdsByNativeTurn.delete("turn-a");
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "late pruned A" },
    });

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "commandExecution", id: "late-pruned-tool", command: "echo stale" },
      },
    });


    await provider.flushCanonicalEvents();
    const lateText = events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TextDelta && runtimeEvent.event.delta === "late pruned A");
    await provider.flushCanonicalEvents();
    const lateTool = events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.ToolUse && runtimeEvent.event.toolCallId === "late-pruned-tool");

    await provider.flushCanonicalEvents();
    expect(lateText?.event.turnExecutionId).not.toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(lateTool?.event.turnExecutionId).not.toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("binds first child turn/start to B and preserves reused child A generation", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-generation", "child-generation");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused", kind: "started", agentThreadId: "child-reused" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-child-generation",
      workspaceId: "workspace-test",
      threadId: "child-generation",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-first", turn: { id: "child-turn-first" } },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-prelink-reused" } },
    });

    const preLinkMaps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(preLinkMaps.turnExecutionIdsByNativeTurn.get("child-turn-first")).toBeUndefined();

    await provider.flushCanonicalEvents();
    expect(preLinkMaps.turnExecutionIdsByNativeTurn.get("child-turn-prelink-reused")).toBeUndefined();
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-child-new", kind: "started", agentThreadId: "child-new" },
      },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-reused-b", kind: "started", agentThreadId: "child-reused" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-new", turn: { id: "child-turn-b" } },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-b-reused" } },
    });

    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(maps.nativeThreadExecutionIds.get("child-new")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("4d236715-3c85-42c1-8ae5-7b086ccf5fb1");

    await provider.flushCanonicalEvents();
    expect(maps.nativeThreadExecutionIds.get("child-reused")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b-reused")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
    void events;
  });

  it("does not let a late A parent activity replace the active B child generation", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-late-parent", "late-parent");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused-a", kind: "started", agentThreadId: "child-reused" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-late-parent",
      workspaceId: "workspace-test",
      threadId: "late-parent",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-reused-b", kind: "started", agentThreadId: "child-reused" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused-a-late", kind: "started", agentThreadId: "child-reused" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-reused",
        turnId: "child-turn-b",
        item: { type: "imageGeneration", id: "child-b-image", savedPath: "C:/tmp/child-b.png" },
      },
    });

    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(maps.nativeThreadExecutionIds.get("child-reused")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.GeneratedAttachment)?.event.turnExecutionId).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("keeps B child attribution after a stale A main turn/started replay", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-stale-main", "stale-main");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-stale-main",
      workspaceId: "workspace-test",
      threadId: "stale-main",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-stale-main", kind: "started", agentThreadId: "child-stale-main" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-stale-main", turn: { id: "child-turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-stale-main",
        turnId: "child-turn-b",
        item: { type: "imageGeneration", id: "stale-main-b-image", savedPath: "C:/tmp/stale-main-b.png" },
      },
    });

    await provider.flushCanonicalEvents();
    expect(events.find((runtimeEvent) => runtimeEvent.event.type === AgentEventType.GeneratedAttachment)?.event.turnExecutionId).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("links a current B parent activity without a turn id to B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-parent-no-turn", "parent-no-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-parent-no-turn",
      workspaceId: "workspace-test",
      threadId: "parent-no-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: { type: "subAgentActivity", id: "call-no-turn", kind: "started", agentThreadId: "child-no-turn" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-no-turn", turn: { id: "child-turn-b" } },
    });

    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("keeps old A child events A while new B child events stay B after late replay", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-child-replay-events", "child-replay-events");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-replay-a", kind: "started", agentThreadId: "child-replay" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-replay", turn: { id: "child-turn-a" } },
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "c6239384-cf6e-4b69-809a-6d00ed0980c6",
      sessionId: "mcode-child-replay-events",
      workspaceId: "workspace-test",
      threadId: "child-replay-events",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "c6239384-cf6e-4b69-809a-6d00ed0980c6";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-replay-b", kind: "started", agentThreadId: "child-replay" },
      },
    });

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-replay-a-late", kind: "started", agentThreadId: "child-replay" },
      },
    });

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-replay", turn: { id: "child-turn-b" } },
    });

    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("d6852ce1-d3bd-4515-8578-469375ad5a97");

    await provider.flushCanonicalEvents();
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");

    await provider.flushCanonicalEvents();
    expect(maps.nativeThreadExecutionIds.get("child-replay")).toBe("c6239384-cf6e-4b69-809a-6d00ed0980c6");
  });

  it("interrupts one exact child through the existing runtime session", async () => {
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-child-stop", "child-stop");

    await provider.interruptChildTurn(
      "mcode-child-stop",
      "native-child-thread",
      "native-child-turn",
    );

    await provider.flushCanonicalEvents();
    expect(interruptChildTurnMock).toHaveBeenCalledOnce();

    await provider.flushCanonicalEvents();
    expect(interruptChildTurnMock).toHaveBeenCalledWith(
      "native-child-thread",
      "native-child-turn",
    );

    await provider.flushCanonicalEvents();
    expect((provider as unknown as {
      runtime: { get: (sessionId: string) => PoolEntry | undefined };
    }).runtime.get("mcode-child-stop")).toBe(entry);
  });
});
