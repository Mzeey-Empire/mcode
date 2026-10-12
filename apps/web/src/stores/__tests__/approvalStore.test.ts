import { beforeEach, describe, expect, it } from "vitest";
import { createMockApproval } from "@/__tests__/mocks/transport";
import { useApprovalStore } from "../approvalStore";

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
