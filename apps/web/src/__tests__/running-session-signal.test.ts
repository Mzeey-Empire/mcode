import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { createMockThread } from "./mocks/transport";

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

  it("is idempotent: repeat turnStarted does not create duplicates", () => {
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

describe("session.turnStarted clears interrupted status", () => {
  beforeEach(() => {
    useThreadStore.setState({ runningThreadIds: new Set(), currentThreadId: null, messages: [] });
    useWorkspaceStore.setState({
      threads: [createMockThread({ id: "t-1", status: "interrupted" })],
      activeThreadId: "t-1",
    });
  });

  it("updates workspace store thread status from interrupted to active on turnStarted", () => {
    useThreadStore.getState().handleAgentEvent("t-1", {
      method: "session.turnStarted",
      type: "turnStarted",
      threadId: "t-1",
    });

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t-1");
    expect(thread?.status).toBe("active");
  });

  it("does not change status for non-interrupted threads on turnStarted", () => {
    useWorkspaceStore.setState({
      threads: [createMockThread({ id: "t-1", status: "active" })],
      activeThreadId: "t-1",
    });

    useThreadStore.getState().handleAgentEvent("t-1", {
      method: "session.turnStarted",
      type: "turnStarted",
      threadId: "t-1",
    });

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t-1");
    expect(thread?.status).toBe("active");
  });
});
