// @vitest-environment jsdom
import { createMockThread, createMockThreadStartup, createMockWorkspace } from "@mcode/contracts/testing";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import type { CreateAndSendResult } from "@mcode/contracts/ws/methods";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { __clearPendingThreadCreationsForTests, useWorkspaceStore, type PendingStartup } from "@/features/projects/state/workspaceStore";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { threadAttentionStore } from "../thread-attention-store";
import { deriveThreadActivity, startupHolds, type StartupActivity, type ThreadActivityFacts } from "../thread-activity";
import { readThreadRowState, useThreadRowState } from "../thread-row-presentation";
import type { ThreadRowState } from "../thread-row-state";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const SEEN = "2026-11-19T12:00:00.000Z";
const SETUP_APPROVAL: NonNullable<ThreadStartup["block"]> = { code: "SETUP_APPROVAL_REQUIRED", message: "", actions: ["retry", "continue"] };
const SETUP_FAILED: NonNullable<ThreadStartup["block"]> = { code: "SETUP_FAILED", message: "", actions: ["retry", "continue"] };
const FETCH_FAILED: NonNullable<ThreadStartup["block"]> = { code: "start_from_origin_failed", message: "", actions: ["retry", "continue"] };
const NO_LOCAL: ThreadActivityFacts["local"] = { preparing: false, pendingStartup: false, createFailed: false };

function record(overrides: Partial<ThreadStartup>): ThreadStartup {
  return createMockThreadStartup({ startupId: "startup-1", threadId: "a", ...overrides });
}

function startupOf(facts: Partial<ThreadActivityFacts>): StartupActivity {
  return deriveThreadActivity({ record: undefined, local: NO_LOCAL, turnRunning: false, ...facts }).startup;
}

function applyRecord(startup: ThreadStartup): void {
  act(() => useThreadStartupStore.getState().apply(startup));
}

beforeEach(() => {
  resetThreadStoreForTests();
  __clearPendingThreadCreationsForTests();
  threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
  useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, pendingStartupByThreadId: {} });
  useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {}, dismissedStartupIds: new Set() });
});

describe("deriveThreadActivity", () => {
  it.each<[string, Partial<ThreadStartup>, StartupActivity]>([
    ["pending", { state: "pending", phase: "thread" }, { kind: "setting-up", phase: "thread" }],
    ["running fetch", { state: "running", phase: "fetch" }, { kind: "setting-up", phase: "fetch" }],
    ["running worktree", { state: "running", phase: "worktree" }, { kind: "setting-up", phase: "worktree" }],
    ["running setup", { state: "running", phase: "setup" }, { kind: "setting-up", phase: "setup" }],
    ["running agent", { state: "running", phase: "agent" }, { kind: "setting-up", phase: "agent" }],
    ["setup approval", { state: "blocked", phase: "setup", block: SETUP_APPROVAL }, { kind: "needs-you", decision: "setup-approval" }],
    ["setup failure", { state: "blocked", phase: "setup", block: SETUP_FAILED }, { kind: "needs-you", decision: "setup-failed" }],
    ["blocked fetch", { state: "blocked", phase: "fetch", block: FETCH_FAILED }, { kind: "needs-you", decision: "fetch-failed" }],
    ["block with no known decision", { state: "blocked", phase: "worktree" }, { kind: "needs-you", decision: "setup-failed" }],
    ["interrupted setup", { state: "interrupted", phase: "setup" }, { kind: "needs-you", decision: "setup-failed" }],
    ["unseen interrupted worktree", { state: "interrupted", phase: "worktree" }, { kind: "failed" }],
    ["seen interrupted worktree", { state: "interrupted", phase: "worktree", failureSeenAt: SEEN }, { kind: "none" }],
    ["unseen failed agent", { state: "failed", phase: "agent" }, { kind: "failed" }],
    ["seen failed agent", { state: "failed", phase: "agent", failureSeenAt: SEEN }, { kind: "none" }],
    ["completed", { state: "completed", phase: "agent" }, { kind: "none" }],
    ["cancelled", { state: "cancelled", phase: "worktree" }, { kind: "none" }],
  ])("reads a %s record", (_name, overrides, expected) => {
    expect(startupOf({ record: record(overrides) })).toEqual(expected);
  });

  it.each<[string, Partial<ThreadActivityFacts["local"]>, StartupActivity]>([
    ["no placeholder", {}, { kind: "none" }],
    ["a preparing placeholder", { preparing: true }, { kind: "setting-up", phase: null }],
    ["a pending startup", { pendingStartup: true }, { kind: "setting-up", phase: null }],
    ["a failed create over its pending startup", { createFailed: true, pendingStartup: true }, { kind: "failed" }],
  ])("reads %s without a record", (_name, local, expected) => {
    expect(startupOf({ local: { ...NO_LOCAL, ...local } })).toEqual(expected);
  });

  it("lets the record win over a stale placeholder", () => {
    const local = { preparing: true, pendingStartup: true, createFailed: false };
    expect(startupOf({ local, record: record({ state: "completed", phase: "agent" }) })).toEqual({ kind: "none" });
  });

  it("holds the thread only while setting up or waiting on the user", () => {
    const holds = (startup: Partial<ThreadStartup>) => startupHolds(deriveThreadActivity({ record: record(startup), local: NO_LOCAL, turnRunning: false }));
    expect(holds({ state: "running", phase: "worktree" })).toBe(true);
    expect(holds({ state: "blocked", phase: "fetch", block: FETCH_FAILED })).toBe(true);
    expect(holds({ state: "failed", phase: "agent" })).toBe(false);
    expect(holds({ state: "cancelled", phase: "worktree" })).toBe(false);
  });
});

describe("row state from the startup record", () => {
  it.each(["fetch", "worktree", "agent"] as const)("shows Setting up for a running %s with no pending entry", (phase) => {
    applyRecord(record({ state: "running", phase }));
    expect(readThreadRowState("a")).toEqual({ kind: "setting-up", phase });
  });

  it("shows Fetch failed for a blocked fetch, even with this window's pending entry", () => {
    useWorkspaceStore.setState({ pendingStartupByThreadId: { a: { startupId: "startup-1", context: "new-worktree", queuedMessage: "hi" } } });
    applyRecord(record({ state: "blocked", phase: "fetch", block: FETCH_FAILED }));
    expect(readThreadRowState("a")).toEqual({ kind: "needs-you", label: "Fetch failed" });
  });

  it("shows an unseen failed startup as failed while on screen, and a seen one as quiet", () => {
    threadAttentionStore.setState({ onScreenThreadId: "a" });
    applyRecord(record({ state: "failed", phase: "agent", revision: 1 }));
    expect(readThreadRowState("a").kind).toBe("failed");
    applyRecord(record({ state: "failed", phase: "agent", revision: 2, failureSeenAt: SEEN }));
    expect(readThreadRowState("a").kind).toBe("quiet");
  });

  it("shows Approval required for a setup waiting on approval", () => {
    applyRecord(record({ state: "blocked", phase: "setup", block: SETUP_APPROVAL }));
    expect(readThreadRowState("a")).toEqual({ kind: "needs-you", label: "Approval required" });
  });

  it("shows Setting up after a reload recovers a running worktree record", async () => {
    vi.mocked(mockTransport.listThreadStartups).mockResolvedValueOnce({ records: [record({ state: "running", phase: "worktree" })] });
    await act(() => useThreadStartupStore.getState().recover({ workspaceId: "workspace-1" }));
    expect(useWorkspaceStore.getState().pendingStartupByThreadId).toEqual({});
    expect(readThreadRowState("a")).toEqual({ kind: "setting-up", phase: "worktree" });
  });

  it("goes quiet and releases the thread when the startup is cancelled", () => {
    const { result } = renderHook(() => useThreadRowState("a"));
    applyRecord(record({ state: "running", phase: "worktree", revision: 1 }));
    expect(result.current.kind).toBe("setting-up");
    applyRecord(record({ state: "cancelled", phase: "worktree", revision: 2 }));
    expect(result.current.kind).toBe("quiet");
  });

  it("reads Setting up again when an agent retry moves the same record from failed back to running", () => {
    applyRecord(record({ state: "failed", phase: "agent", revision: 1 }));
    expect(readThreadRowState("a").kind).toBe("failed");
    applyRecord(record({ state: "running", phase: "agent", revision: 2 }));
    expect(readThreadRowState("a")).toEqual({ kind: "setting-up", phase: "agent" });
  });
});

describe("hand-off in the sending window", () => {
  const WORKSPACE = createMockWorkspace({ id: "workspace-1" });
  const DURABLE_ID = "server-thread-1";

  function activeRowKind(): ThreadRowState["kind"] {
    const { activeThreadId, threads } = useWorkspaceStore.getState();
    const thread = threads.find((candidate) => candidate.id === activeThreadId);
    if (!activeThreadId || !thread) return "quiet";
    return readThreadRowState(activeThreadId, thread.clientPreparing === true, thread.clientError != null).kind;
  }

  function pendingStartup(): PendingStartup {
    const pending = Object.values(useWorkspaceStore.getState().pendingStartupByThreadId)[0];
    if (!pending) throw new Error("no pending startup");
    return pending;
  }

  function createResult(): CreateAndSendResult {
    const thread = createMockThread({ id: DURABLE_ID, workspace_id: WORKSPACE.id });
    return { ...thread, runtimeSnapshot: { threadId: DURABLE_ID, turnExecutionId: null, phase: "idle" } };
  }

  type Step = "response" | "binding" | "completed";

  async function runHandOff(order: readonly Step[]): Promise<ThreadRowState["kind"][]> {
    useWorkspaceStore.setState({ workspaces: [WORKSPACE], activeWorkspaceId: WORKSPACE.id });
    let respond!: (result: CreateAndSendResult) => void;
    vi.mocked(mockTransport.createAndSendMessage).mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
    const done = useWorkspaceStore.getState().createAndSendMessage("Hello", "gpt-5.5");
    await Promise.resolve();
    const { startupId } = pendingStartup();
    const seen = [activeRowKind()];
    const push = (state: ThreadStartup["state"], revision: number) =>
      useThreadStartupStore.getState().apply(createMockThreadStartup({ startupId, threadId: DURABLE_ID, workspaceId: WORKSPACE.id, state, phase: "agent", revision }));
    for (const step of order) {
      if (step === "response") {
        respond(createResult());
        await done;
      } else {
        push(step === "binding" ? "running" : "completed", step === "binding" ? 1 : 2);
      }
      seen.push(activeRowKind());
    }
    return seen;
  }

  const collapse = (kinds: readonly ThreadRowState["kind"][]) => kinds.filter((kind, index) => kind !== kinds[index - 1]);

  it.each<[string, Step[]]>([
    ["response, binding, completed", ["response", "binding", "completed"]],
    ["completed before the response", ["binding", "completed", "response"]],
    ["binding before the response", ["binding", "response", "completed"]],
  ])("shows Setting up then Running, never Quiet: %s", async (_name, order) => {
    expect(collapse(await runHandOff(order))).toEqual(["setting-up", "running"]);
  });
});
