// @vitest-environment jsdom
import { createMockThread, createMockThreadAttention } from "@mcode/contracts/testing";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useWorkspaceStore, type PendingStartup } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "../thread-attention-store";
import { useOpenThreadsRowState, useRolledUpThreadRowState } from "../thread-rollup";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const AT = "2026-10-10T10:00:00.000Z";
const PENDING_STARTUP: PendingStartup = { startupId: "a", context: "new-direct", queuedMessage: "hello" };

function attention(threadId: string, overrides: Partial<ThreadAttention> = {}): ThreadAttention {
  return createMockThreadAttention({ threadId, ...overrides });
}

function endedTurn(outcome: TurnOutcome): Pick<ThreadAttention, "lastTurn"> {
  return { lastTurn: { outcome, endedAt: AT, sequence: 7, changedFileCount: null } };
}

beforeEach(() => {
  threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
  useWorkspaceStore.setState({ threads: [], pendingStartupByThreadId: {} });
});

describe("useOpenThreadsRowState", () => {
  it("shows needs-you for an open thread awaiting approval", () => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "a" })] });
    threadAttentionStore.setState({ byThreadId: { a: attention("a", { waiting: { kind: "approval", since: AT } }) } });
    const { result } = renderHook(() => useOpenThreadsRowState());
    expect(result.current.kind).toBe("needs-you");
  });

  it("ignores a completed thread awaiting approval", () => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "a", user_completed_at: AT })] });
    threadAttentionStore.setState({ byThreadId: { a: attention("a", { waiting: { kind: "approval", since: AT } }) } });
    const { result } = renderHook(() => useOpenThreadsRowState());
    expect(result.current.kind).toBe("quiet");
  });

  it("follows a thread when the store changes", () => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "a" })] });
    const { result } = renderHook(() => useOpenThreadsRowState());
    expect(result.current.kind).toBe("quiet");
    act(() => threadAttentionStore.getState().apply(attention("a", endedTurn("errored"))));
    expect(result.current.kind).toBe("failed");
  });
});

describe("useRolledUpThreadRowState", () => {
  it("keeps a finished thread quiet while it is on screen", () => {
    threadAttentionStore.setState({ byThreadId: { a: attention("a", endedTurn("completed")) }, onScreenThreadId: "a" });
    const { result } = renderHook(() => useRolledUpThreadRowState([{ id: "a" }]));
    expect(result.current.kind).toBe("quiet");
  });

  it("ranks a preparing thread's setting up above finished", () => {
    threadAttentionStore.setState({ byThreadId: { b: attention("b", endedTurn("completed")) } });
    const { result } = renderHook(() => useRolledUpThreadRowState([{ id: "a", clientPreparing: true }, { id: "b" }]));
    expect(result.current.kind).toBe("setting-up");
  });

  it("shows failed, not running, for a thread whose creation failed", () => {
    useWorkspaceStore.setState({ threads: [{ ...createMockThread({ id: "a" }), clientError: "create failed" }], pendingStartupByThreadId: { a: PENDING_STARTUP } });
    const { result } = renderHook(() => useOpenThreadsRowState());
    expect(result.current.kind).toBe("failed");
  });

  it("is quiet for no threads", () => {
    const { result } = renderHook(() => useRolledUpThreadRowState([]));
    expect(result.current.kind).toBe("quiet");
  });
});
