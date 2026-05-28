import {
  resetThreadStoreForTests,
  getTestAgentStartTimes,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { hydrateRunningThreadsFromServer } from "@/transport/ws-transport";

describe("hydrateRunningThreadsFromServer", () => {
  beforeEach(() => {
    useThreadStore.setState({ runningThreadIds: new Set(["stale"]) });
  });

  it("replaces runningThreadIds with the RPC result", async () => {
    const rpc = vi.fn().mockResolvedValue(["t-1", "t-2"]);
    await hydrateRunningThreadsFromServer(rpc);
    expect(rpc).toHaveBeenCalledWith("agent.listRunning", {});
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(false);
    expect(ids.has("t-1")).toBe(true);
    expect(ids.has("t-2")).toBe(true);
  });

  it("leaves runningThreadIds unchanged if the RPC rejects", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network"));
    await hydrateRunningThreadsFromServer(rpc);
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(true);
  });

  it("clears runningThreadIds when the server returns an empty array", async () => {
    const rpc = vi.fn().mockResolvedValue([]);
    await hydrateRunningThreadsFromServer(rpc);
    expect(useThreadStore.getState().runningThreadIds.size).toBe(0);
  });

  it("preserves threadIds added while the RPC is in flight", async () => {
    // Start with one stale id. The server will return ["t-server"] but a
    // concurrent session.turnStarted push will add "t-concurrent" DURING the
    // RPC. The final Set must contain both server ids and the concurrent add,
    // but NOT the stale one.
    let resolveRpc: (v: string[]) => void = () => {};
    const rpcPromise = new Promise<string[]>((r) => { resolveRpc = r; });
    const rpc = vi.fn().mockReturnValue(rpcPromise);

    const pending = hydrateRunningThreadsFromServer(rpc);

    // Flush all pending microtasks (including the dynamic import resolution
    // chain) before simulating the concurrent push. A single setTimeout(0)
    // enqueues a macrotask; the event loop drains all microtasks first,
    // guaranteeing `beforeRpc` is captured before we mutate the store.
    await new Promise((r) => setTimeout(r, 0));

    // Simulate a concurrent turnStarted push that adds a new threadId.
    useThreadStore.setState((state) => {
      const next = new Set(state.runningThreadIds);
      next.add("t-concurrent");
      return { runningThreadIds: next };
    });

    // Now resolve the RPC with the server's snapshot (which does NOT include t-concurrent).
    resolveRpc(["t-server"]);
    await pending;

    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(false);          // dropped (server doesn't report it)
    expect(ids.has("t-server")).toBe(true);        // server's truth
    expect(ids.has("t-concurrent")).toBe(true);    // concurrent add preserved
  });
});

describe("hydrateRunningThreads (store action)", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(),
    });
  });

  it("preserves Set reference when hydration matches current membership", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1", "t-2"]) });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);

    const after = useThreadStore.getState().runningThreadIds;
    // Same Set reference (no churn) avoids re-rendering all subscribers.
    expect(after).toBe(before);
  });

  it("preserves Set reference when hydration matches (order-insensitive)", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1", "t-2"]) });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-2", "t-1"]);

    const after = useThreadStore.getState().runningThreadIds;
    expect(after).toBe(before);
  });

  it("creates a new Set reference when hydration membership differs", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1", "t-2"]) });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-3"]);

    const after = useThreadStore.getState().runningThreadIds;
    expect(after).not.toBe(before);
    expect(after.has("t-1")).toBe(true);
    expect(after.has("t-2")).toBe(false);
    expect(after.has("t-3")).toBe(true);
  });

  it("seeds agentStartTimes for newly hydrated ids and preserves existing entries", () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(["t-1"]),
      records: new Map<string, ThreadRecord>([
        ["t-1", { ...createEmptyThreadRecord(), agentStartTime: 100 }],
      ]),
    });
    vi.spyOn(Date, "now").mockReturnValue(200);

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);

    const times = getTestAgentStartTimes();
    // Existing optimistic timestamp from a user-initiated send must not be clobbered.
    expect(times["t-1"]).toBe(100);
    // New id gets seeded with Date.now() so UI elapsed readouts (MessageList
    // "running for Xs") render correctly before the next server event arrives.
    expect(times["t-2"]).toBe(200);

    vi.restoreAllMocks();
  });
});
