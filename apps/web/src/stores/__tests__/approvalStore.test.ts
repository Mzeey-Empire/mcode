import { createMockApproval } from "@mcode/contracts/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { selectDockApprovals, useApprovalStore } from "../approvalStore";

const requestA = createMockApproval({ requestId: "req-a", threadId: "thread-a" });
const requestB = createMockApproval({ requestId: "req-b", threadId: "thread-b" });

function approvalStates(): Array<[string, string, boolean]> {
  return useApprovalStore.getState().approvals.map((item) => [item.requestId, item.threadId, item.settled]);
}

describe("approvalStore.hydrate", () => {
  beforeEach(() => {
    useApprovalStore.setState({ approvals: [] });
  });

  it("flags a pending request on a background thread that was never opened", () => {
    useApprovalStore.getState().hydrate([requestB]);

    expect(approvalStates()).toEqual([["req-b", "thread-b", false]]);
  });

  it("replaces pending items with a reconnect snapshot without duplicating repeats", () => {
    useApprovalStore.getState().hydrate([requestA, requestB]);

    useApprovalStore.getState().hydrate([requestB]);

    expect(approvalStates()).toEqual([["req-b", "thread-b", false]]);
  });

  it("does not resurrect a settled request that a stale snapshot still lists", () => {
    useApprovalStore.getState().add(requestB);
    useApprovalStore.getState().resolve("req-b");

    useApprovalStore.getState().hydrate([requestA, requestB]);

    expect(approvalStates()).toEqual([
      ["req-b", "thread-b", true],
      ["req-a", "thread-a", false],
    ]);
  });

  it("settles a hydrated background request when another client resolves it", () => {
    useApprovalStore.getState().hydrate([requestA, requestB]);

    useApprovalStore.getState().add(requestB);
    useApprovalStore.getState().resolve("req-b");

    expect(approvalStates()).toEqual([
      ["req-a", "thread-a", false],
      ["req-b", "thread-b", true],
    ]);
  });
});

describe("approvalStore.clearThread", () => {
  beforeEach(() => {
    useApprovalStore.setState({ approvals: [] });
  });

  it("keeps a delegation approval waiting after the Coordinator's turn ends", () => {
    const delegation = createMockApproval({
      requestId: "req-task", threadId: "thread-a",
      subject: { kind: "delegate_task", taskId: "req-task", title: "Fix flaky test", providerId: "codex", modelId: "gpt-5.6-luna", isolation: "worktree", commit: "9267e789dbb2" },
    });
    useApprovalStore.getState().hydrate([requestA, delegation]);

    useApprovalStore.getState().clearThread("thread-a");

    expect(approvalStates()).toEqual([["req-task", "thread-a", false]]);
  });
});

describe("selectDockApprovals", () => {
  it("shows a Delegated thread's request in its Coordinator's dock and leaves unrelated threads out", () => {
    const own = { ...createMockApproval({ requestId: "own", threadId: "coordinator" }), requestedAt: "2026-10-21T10:00:00.000Z", settled: false };
    const child = { ...createMockApproval({ requestId: "child", threadId: "delegated" }), requestedAt: "2026-10-21T10:00:01.000Z", settled: false };
    const other = { ...createMockApproval({ requestId: "other", threadId: "unrelated" }), requestedAt: "2026-10-21T10:00:02.000Z", settled: false };

    const dock = selectDockApprovals([other, child, own], "coordinator", new Set(["delegated"]));

    expect(dock.map((request) => request.requestId)).toEqual(["own", "child"]);
  });
});
