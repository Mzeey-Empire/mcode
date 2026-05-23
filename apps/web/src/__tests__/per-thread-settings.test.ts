import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, TOOL_CALL_CACHE_SIZE } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { LruCache } from "@/lib/lru-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("per-thread settings", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      toolCallsByThread: {},
      currentThreadId: null,
      persistedToolCallCounts: {},
      serverMessageIds: {},
      toolCallRecordCache: new LruCache(TOOL_CALL_CACHE_SIZE),
      currentTurnMessageIdByThread: {},
      agentStartTimes: {},
      settingsByThread: {},
      oldestLoadedSequence: {},
      hasMoreMessages: {},
      isLoadingMore: {},
      loadEpochByThread: {},
    });
    useWorkspaceStore.setState({ threads: [] });
    vi.clearAllMocks();
  });

  it("hydrates from DB-persisted thread fields when no in-memory override exists", () => {
    const thread = createMockThread({
      id: "thread-db",
      reasoning_level: "max",
      interaction_mode: "plan",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    const settings = useThreadStore.getState().getThreadSettings("thread-db");

    expect(settings.reasoningLevel).toBe("max");
    expect(settings.interactionMode).toBe("plan");
    expect(settings.permissionMode).toBe("supervised");
  });

  it("falls back to global defaults when all thread settings are null", () => {
    const thread = createMockThread({
      id: "thread-null",
      reasoning_level: null,
      interaction_mode: null,
      permission_mode: null,
    });
    useWorkspaceStore.setState({ threads: [thread] });

    const settings = useThreadStore.getState().getThreadSettings("thread-null");

    expect(settings.interactionMode).toBe("chat");
    expect(settings.permissionMode).toBe("full");
    expect(settings.reasoningLevel).toBeUndefined();
    expect(settings.codexFastMode).toBeNull();
  });

  it("hydrates codex_fast_mode from the thread row", () => {
    const thread = createMockThread({
      id: "thread-codex",
      codex_fast_mode: true,
    });
    useWorkspaceStore.setState({ threads: [thread] });
    expect(useThreadStore.getState().getThreadSettings("thread-codex").codexFastMode).toBe(true);
  });

  it("setThreadSettings forwards codexFastMode to updateThreadSettings", async () => {
    const thread = createMockThread({ id: "thread-codex-patch" });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-codex-patch", { codexFastMode: false });

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("thread-codex-patch", {
      codexFastMode: false,
    });
    const updated = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-codex-patch");
    expect(updated?.codex_fast_mode).toBe(false);
  });

  it("in-memory override takes precedence over DB-persisted values", () => {
    const thread = createMockThread({
      id: "thread-override",
      reasoning_level: "max",
      interaction_mode: "plan",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    // Apply an in-memory override
    useThreadStore.setState({
      settingsByThread: {
        "thread-override": {
          permissionMode: "full",
          interactionMode: "chat",
          reasoningLevel: undefined,
        },
      },
    });

    const settings = useThreadStore.getState().getThreadSettings("thread-override");

    expect(settings.permissionMode).toBe("full");
    expect(settings.interactionMode).toBe("chat");
    expect(settings.reasoningLevel).toBeUndefined();
  });

  it("setThreadSettings persists to server via updateThreadSettings RPC", async () => {
    const thread = createMockThread({ id: "thread-rpc" });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-rpc", {
      permissionMode: "supervised",
    });

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("thread-rpc", {
      permissionMode: "supervised",
    });
  });

  it("partial setThreadSettings does not clear other persisted settings", () => {
    // Seed thread with all three settings in DB
    useWorkspaceStore.setState({
      threads: [
        createMockThread({
          id: "thread-1",
          reasoning_level: "high",
          interaction_mode: "plan",
          permission_mode: "supervised",
        }),
      ],
    });

    // Set only interactionMode
    useThreadStore.getState().setThreadSettings("thread-1", { interactionMode: "chat" });

    // Other settings should be preserved from DB, not cleared
    const settings = useThreadStore.getState().getThreadSettings("thread-1");
    expect(settings.interactionMode).toBe("chat");
    expect(settings.reasoningLevel).toBe("high");
    expect(settings.permissionMode).toBe("supervised");
  });

  it("setThreadSettings mirrors the patch into workspaceStore.threads", async () => {
    const thread = createMockThread({
      id: "thread-sync",
      reasoning_level: null,
      interaction_mode: "chat",
      permission_mode: "supervised",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore
      .getState()
      .setThreadSettings("thread-sync", { permissionMode: "full" });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync");
    expect(updated?.permission_mode).toBe("full");
  });

  it("setThreadSettings mirrors all provided fields, leaving others untouched", async () => {
    const thread = createMockThread({
      id: "thread-sync-2",
      reasoning_level: "max",
      interaction_mode: "chat",
      permission_mode: "supervised",
      copilot_agent: "code",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().setThreadSettings("thread-sync-2", {
      permissionMode: "full",
      interactionMode: "plan",
    });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync-2");
    expect(updated?.permission_mode).toBe("full");
    expect(updated?.interaction_mode).toBe("plan");
    expect(updated?.reasoning_level).toBe("max");
    expect(updated?.copilot_agent).toBe("code");
  });

  it("setThreadSettings with copilotAgent: null clears the cached value", async () => {
    const thread = createMockThread({
      id: "thread-sync-3",
      copilot_agent: "code",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore
      .getState()
      .setThreadSettings("thread-sync-3", { copilotAgent: null });

    const updated = useWorkspaceStore
      .getState()
      .threads.find((t) => t.id === "thread-sync-3");
    expect(updated?.copilot_agent).toBeNull();
  });

  it("sendPlanAction implement switches interaction mode to chat", async () => {
    const thread = createMockThread({
      id: "thread-implement",
      interaction_mode: "plan",
    });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().sendPlanAction(
      "thread-implement",
      "Implement the plan.",
      "implement",
    );

    expect(useThreadStore.getState().getThreadSettings("thread-implement").interactionMode).toBe("chat");
    expect(
      useWorkspaceStore.getState().threads.find((t) => t.id === "thread-implement")?.interaction_mode,
    ).toBe("chat");
    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith(
      "thread-implement",
      expect.objectContaining({ interactionMode: "chat" }),
    );

    const calls = vi.mocked(mockTransport.sendMessage).mock.calls;
    const sendCall = calls[calls.length - 1];
    expect(sendCall?.[8]).toBe("chat");
  });
});
