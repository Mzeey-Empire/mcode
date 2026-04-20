import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

describe("running-session signal", () => {
  beforeEach(() => {
    useThreadStore.setState({
      runningThreadIds: new Set(),
      currentThreadId: null,
      messages: [],
    });
  });

  it("adds threadId to runningThreadIds on session.turnStarted", () => {
    useThreadStore.getState().handleAgentEvent("t-1", {
      method: "session.turnStarted",
      type: "turnStarted",
      threadId: "t-1",
    });
    expect(useThreadStore.getState().runningThreadIds.has("t-1")).toBe(true);
    expect(typeof useThreadStore.getState().agentStartTimes["t-1"]).toBe("number");
  });

  it("is idempotent — repeat turnStarted does not create duplicates", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = useThreadStore.getState();
    store.handleAgentEvent("t-1", { method: "session.turnStarted", type: "turnStarted", threadId: "t-1" });
    const firstStart = useThreadStore.getState().agentStartTimes["t-1"];
    store.handleAgentEvent("t-1", { method: "session.turnStarted", type: "turnStarted", threadId: "t-1" });
    expect(useThreadStore.getState().runningThreadIds.size).toBe(1);
    expect(useThreadStore.getState().agentStartTimes["t-1"]).toBe(firstStart);
    vi.restoreAllMocks();
  });

  it("turnStarted then turnComplete leaves the Set empty", () => {
    const store = useThreadStore.getState();
    store.handleAgentEvent("t-1", { method: "session.turnStarted", type: "turnStarted", threadId: "t-1" });
    store.handleAgentEvent("t-1", {
      method: "session.turnComplete",
      type: "turnComplete",
      threadId: "t-1",
      reason: "stop",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(useThreadStore.getState().runningThreadIds.has("t-1")).toBe(false);
  });

  it("hydrateRunningThreads replaces the Set", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["stale"]) });
    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(false);
    expect(ids.has("t-1")).toBe(true);
    expect(ids.has("t-2")).toBe(true);
  });
});
