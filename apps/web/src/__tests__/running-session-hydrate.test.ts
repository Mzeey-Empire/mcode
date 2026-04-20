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
