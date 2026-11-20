import { createMockThreadStartup } from "@mcode/contracts/testing";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { useComposerSurfaceState } from "./useComposerSurfaceState";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const FETCH_FAILED: NonNullable<ThreadStartup["block"]> = { code: "start_from_origin_failed", message: "", actions: ["retry", "continue"] };

function renderLocks(activeThread: { clientPreparing?: boolean; clientError?: string | null } = {}) {
  return renderHook(() => useComposerSurfaceState({
    threadId: "a",
    isNewThread: false,
    activeThread,
    composerMode: "direct",
    provider: "codex",
    hasDraftContent: false,
    isAgentRunning: false,
  }));
}

function applyRecord(overrides: Partial<ThreadStartup>): void {
  act(() => useThreadStartupStore.getState().apply(createMockThreadStartup({ startupId: "startup-1", threadId: "a", ...overrides })));
}

beforeEach(() => {
  useWorkspaceStore.setState({ threads: [], pendingStartupByThreadId: {} });
  useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
});

describe("useComposerSurfaceState starting lock", () => {
  it("locks while the startup sets up and while it waits on the user, then unlocks when it completes", () => {
    const { result } = renderLocks();
    expect(result.current.startingThread).toBe(false);
    applyRecord({ state: "running", phase: "worktree", revision: 1 });
    expect(result.current.startingThread).toBe(true);
    applyRecord({ state: "blocked", phase: "fetch", block: FETCH_FAILED, revision: 2 });
    expect(result.current.startingThread).toBe(true);
    applyRecord({ state: "completed", phase: "agent", revision: 3 });
    expect(result.current.startingThread).toBe(false);
  });

  it("locks a placeholder with a pending startup and a failed create, as before the record exists", () => {
    act(() => useWorkspaceStore.setState({ pendingStartupByThreadId: { a: { startupId: "startup-1", context: "new-direct", queuedMessage: "hi" } } }));
    expect(renderLocks().result.current.startingThread).toBe(true);
    expect(renderLocks({ clientError: "create failed" }).result.current.startingThread).toBe(true);
  });
});
