import type { AgentTurn, ThreadStartup } from "@mcode/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startupTransport = {
  cancelThreadStartup: vi.fn(),
  resolveThreadStartup: vi.fn(),
  retryErroredTurn: vi.fn(),
};

vi.mock("@/transport", () => ({
  getTransport: () => startupTransport,
}));

import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStartupStore } from "../state/thread-startup-store";
import { useStartupCancel, useStartupFetchDecision, useStartupTurnRetry } from "../useStartupActions";

const startupId = "00000000-0000-4000-8000-000000000001";
const T0 = "2026-09-02T12:00:00.000Z";

function startup(overrides: Partial<ThreadStartup> = {}): ThreadStartup {
  return {
    startupId,
    workspaceId: "workspace-1",
    kind: "managed-worktree",
    state: "running",
    phase: "setup",
    steps: [
      { phase: "thread", state: "completed", startedAt: T0, endedAt: T0 },
      { phase: "setup", state: "running", startedAt: T0 },
      { phase: "agent", state: "pending" },
    ],
    transcript: [],
    cancellation: "none",
    revision: 1,
    threadId: "thread-1",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe("useStartupCancel", () => {
  beforeEach(() => {
    startupTransport.cancelThreadStartup.mockReset();
    useThreadStartupStore.setState({ cancelRequestByStartupId: {} });
  });

  it("withholds cancel while a request is in flight", () => {
    startupTransport.cancelThreadStartup.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useStartupCancel(startup(), undefined));

    act(() => result.current!());

    expect(result.current).toBeUndefined();
    expect(startupTransport.cancelThreadStartup).toHaveBeenCalledWith(startupId);
  });

  it("withholds cancel when another client already requested it", () => {
    const { result } = renderHook(() => useStartupCancel(startup({ cancellation: "requested" }), undefined));

    expect(result.current).toBeUndefined();
  });

  it("offers cancel again after the server records intent but fails to stop", async () => {
    startupTransport.cancelThreadStartup.mockRejectedValueOnce(new Error("setup stop failed"));
    const { result, rerender } = renderHook(
      ({ record }: { record: ThreadStartup }) => useStartupCancel(record, undefined),
      { initialProps: { record: startup() } },
    );

    act(() => result.current!());
    rerender({ record: startup({ cancellation: "requested", revision: 2 }) });

    await waitFor(() => expect(result.current).toBeTypeOf("function"));
  });

  it("offers the retry on every surface, not only the one whose cancel failed", async () => {
    startupTransport.cancelThreadStartup.mockRejectedValueOnce(new Error("agent stop failed"));
    const requested = startup({ cancellation: "requested", revision: 2 });
    const composer = renderHook(() => useStartupCancel(startup(), undefined));
    const trail = renderHook(() => useStartupCancel(requested, undefined));

    act(() => composer.result.current!());

    await waitFor(() => expect(trail.result.current).toBeTypeOf("function"));
  });

  it("withholds cancel once the startup has ended", () => {
    const { result } = renderHook(() => useStartupCancel(startup({ state: "cancelled" }), undefined));

    expect(result.current).toBeUndefined();
  });
});

describe("useStartupFetchDecision", () => {
  const fetchBlocked = startup({
    state: "blocked",
    phase: "fetch",
    steps: [
      { phase: "fetch", state: "running", startedAt: T0, detail: { phase: "fetch", ref: "origin/main", branch: "main" } },
      { phase: "thread", state: "pending" },
      { phase: "worktree", state: "pending" },
      { phase: "setup", state: "pending" },
      { phase: "agent", state: "pending" },
    ],
    threadId: undefined,
    block: {
      code: "start_from_origin_failed",
      message: "Could not fetch origin/main",
      actions: ["retry", "continue"],
    },
  });

  beforeEach(() => {
    startupTransport.resolveThreadStartup.mockReset();
  });

  it("is offered only while the origin fetch is blocked", () => {
    expect(renderHook(() => useStartupFetchDecision(startup())).result.current).toBeUndefined();
    expect(renderHook(() => useStartupFetchDecision(fetchBlocked)).result.current).toMatchObject({ pending: null, localBranch: "main" });
  });

  it("sends the decision and disables both actions until the server answers", async () => {
    let answer!: (next: ThreadStartup) => void;
    startupTransport.resolveThreadStartup.mockReturnValue(new Promise<ThreadStartup>((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useStartupFetchDecision(fetchBlocked));

    act(() => result.current!.resolve("continue"));

    expect(startupTransport.resolveThreadStartup).toHaveBeenCalledWith(startupId, "continue");
    expect(result.current?.pending).toBe("continue");
    await act(async () => answer(fetchBlocked));
    await waitFor(() => expect(result.current?.pending).toBeNull());
  });
});

describe("useStartupTurnRetry", () => {
  function turn(id: string, status: AgentTurn["status"]): AgentTurn {
    return {
      id, threadId: "thread-1", status, trigger: { kind: "user" }, permissionMode: "full",
      approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null,
      executionId: "00000000-0000-4000-8000-000000000042",
      providerIdentities: [], startedAt: T0, providerStartedAt: null, ending: null, endedAt: T0, createdAt: T0, updatedAt: T0,
    };
  }

  function seedTurns(...turns: AgentTurn[]) {
    const record = createEmptyThreadRecord();
    for (const t of turns) record.canonicalAgent.state.turns[t.id] = t;
    resetThreadStoreForTests({ records: new Map([["thread-1", record]]) });
  }

  beforeEach(() => {
    startupTransport.retryErroredTurn.mockReset();
    startupTransport.retryErroredTurn.mockResolvedValue(undefined);
  });

  it("retries the thread's only turn when it errored", async () => {
    seedTurns(turn("turn-1", "Errored"));
    const { result } = renderHook(() => useStartupTurnRetry("thread-1"));
    act(() => result.current?.retry());
    expect(startupTransport.retryErroredTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1" });
    await waitFor(() => expect(result.current?.pending).toBe(false));
  });

  it.each([
    ["the only turn did not error", [turn("turn-1", "Completed")]],
    ["the thread already has a second turn", [turn("turn-1", "Errored"), turn("turn-2", "Errored")]],
    ["the thread has no turn", []],
  ] as const)("offers no retry when %s", (_name, turns) => {
    seedTurns(...turns);
    const { result } = renderHook(() => useStartupTurnRetry("thread-1"));
    expect(result.current).toBeUndefined();
  });
});
