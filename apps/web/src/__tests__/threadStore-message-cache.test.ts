import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { clearMessageCache, getCachedSnapshot } from "@/stores/messageCache";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const fakeMessages = [
  createMockMessage({
    id: "m1",
    thread_id: "t1",
    content: "hello",
  }),
];

describe("loadMessages cache integration", () => {
  beforeEach(() => {
    clearMessageCache();
    vi.clearAllMocks();
    mockTransport.getMessages.mockResolvedValue({ messages: fakeMessages, hasMore: false });
    useThreadStore.setState({
      messages: [],
      currentThreadId: null,
      runningThreadIds: new Set<string>(),
      loading: false,
    } as Parameters<typeof useThreadStore.setState>[0]);
  });

  it("calls getMessages on first load (cache miss) and populates cache", async () => {
    await useThreadStore.getState().loadMessages("t1");

    expect(mockTransport.getMessages).toHaveBeenCalledWith("t1", 100);
    expect(useThreadStore.getState().messages).toEqual(fakeMessages);
    expect(getCachedSnapshot("t1")).toBeDefined();
    expect(getCachedSnapshot("t1")?.messages).toEqual(fakeMessages);
  });

  it("on cache hit, does not call getMessages and renders from cache", async () => {
    // First load primes the cache
    await useThreadStore.getState().loadMessages("t1");
    expect(mockTransport.getMessages).toHaveBeenCalledTimes(1);

    // Switch away
    useThreadStore.setState({ currentThreadId: "t2", messages: [] });

    // Switch back -- should hit cache
    await useThreadStore.getState().loadMessages("t1");
    expect(mockTransport.getMessages).toHaveBeenCalledTimes(1); // unchanged
    expect(useThreadStore.getState().messages).toEqual(fakeMessages);
    expect(useThreadStore.getState().currentThreadId).toBe("t1");
  });

  it("does NOT clear toolCallRecordCache on cache hit", async () => {
    await useThreadStore.getState().loadMessages("t1");
    useThreadStore.getState().cacheToolCallRecords("t1:m1", [
      { id: "tc1", name: "Read", args: {}, result: "ok", at_ms: 0 } as never,
    ]);
    useThreadStore.setState({ currentThreadId: "t2", messages: [] });

    await useThreadStore.getState().loadMessages("t1");
    expect(useThreadStore.getState().getCachedToolCallRecords("t1:m1")).not.toBeNull();
  });

  it("never sets messages to [] when serving from cache (no blank flash)", async () => {
    await useThreadStore.getState().loadMessages("t1");
    useThreadStore.setState({ currentThreadId: "t2", messages: [] });

    const snapshots: typeof fakeMessages[] = [];
    const unsub = useThreadStore.subscribe((s) => snapshots.push(s.messages));

    await useThreadStore.getState().loadMessages("t1");
    unsub();

    // Every observed messages array should be non-empty for thread t1.
    expect(snapshots.every((m) => m.length > 0)).toBe(true);
  });
});

describe("loadMessages cache eviction", () => {
  beforeEach(() => {
    clearMessageCache();
    vi.clearAllMocks();
    mockTransport.getMessages.mockResolvedValue({ messages: fakeMessages, hasMore: false });
    useThreadStore.setState({
      messages: [],
      currentThreadId: null,
      runningThreadIds: new Set<string>(),
      loading: false,
    } as Parameters<typeof useThreadStore.setState>[0]);
  });

  it("evicts when handleAgentEvent fires for the thread", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedSnapshot("t1")).toBeDefined();

    useThreadStore.getState().handleAgentEvent("t1", { method: "session.message", content: "x" });
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("evicts when handleTurnPersisted fires", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedSnapshot("t1")).toBeDefined();

    useThreadStore.getState().handleTurnPersisted({
      threadId: "t1",
      messageId: "m1",
      toolCallCount: 0,
      filesChanged: [],
    });
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("evicts on clearThreadState", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedSnapshot("t1")).toBeDefined();

    useThreadStore.getState().clearThreadState("t1");
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("evicts all listed threads on clearThreadStateMany", async () => {
    await useThreadStore.getState().loadMessages("t1");
    await useThreadStore.getState().loadMessages("t2");
    expect(getCachedSnapshot("t1")).toBeDefined();
    expect(getCachedSnapshot("t2")).toBeDefined();

    useThreadStore.getState().clearThreadStateMany(["t1", "t2"]);
    expect(getCachedSnapshot("t1")).toBeUndefined();
    expect(getCachedSnapshot("t2")).toBeUndefined();
  });
});
