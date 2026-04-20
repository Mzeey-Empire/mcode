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
});
