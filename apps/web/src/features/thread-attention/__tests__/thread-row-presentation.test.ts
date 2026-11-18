// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore, type PendingStartup } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "../thread-attention-store";
import { threadTitleTone, useThreadRowState } from "../thread-row-presentation";
import type { ThreadRowState } from "../thread-row-state";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const PENDING_STARTUP: PendingStartup = { startupId: "a", context: "new-direct", queuedMessage: "hello" };

beforeEach(() => {
  threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
  useWorkspaceStore.setState({ threads: [], pendingStartupByThreadId: {} });
});

describe("useThreadRowState", () => {
  it("shows failed, not running, for a thread whose creation failed", () => {
    useWorkspaceStore.setState({ pendingStartupByThreadId: { a: PENDING_STARTUP } });
    const { result } = renderHook(() => useThreadRowState("a", false, true));
    expect(result.current.kind).toBe("failed");
  });
});

describe("threadTitleTone", () => {
  it.each<[string, ThreadRowState, boolean, ReturnType<typeof threadTitleTone>]>([
    ["unseen finished outcome is ink", { kind: "finished" }, false, "prominent"],
    ["unseen failure is ink", { kind: "failed" }, false, "prominent"],
    ["blocked on the user is ink", { kind: "needs-you", label: "Approval required" }, false, "prominent"],
    ["quiet thread recedes", { kind: "quiet" }, false, "receded"],
    ["running thread is ink", { kind: "running" }, false, "prominent"],
    ["selected quiet thread stays ink", { kind: "quiet" }, true, "prominent"],
    ["selected running thread stays ink", { kind: "running" }, true, "prominent"],
  ])("%s", (_name, state, selected, tone) => {
    expect(threadTitleTone(state, selected)).toBe(tone);
  });
});
