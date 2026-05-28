import {
  resetThreadStoreForTests,
  getTestThreadContext,
  getTestThreadIsCompacting,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD = "thread-1";

function setup(extra: Partial<ThreadRecord> = {}) {
  // Seed workspaceStore so handleAgentEvent's thread-membership guard passes.
  useWorkspaceStore.setState({
    activeThreadId: THREAD,
    threads: [createMockThread({ id: THREAD })],
  });
  resetThreadStoreForTests({
    currentThreadId: THREAD,
    runningThreadIds: new Set([THREAD]),
    records: new Map<string, ThreadRecord>([
      [
        THREAD,
        {
          ...createEmptyThreadRecord(),
          agentStartTime: Date.now(),
          ...extra,
        },
      ],
    ]),
  });
}

function dispatch(method: string, params: Record<string, unknown> = {}) {
  useThreadStore.getState().handleAgentEvent(THREAD, { method, ...params });
}

describe("context tracker — Fix 2: output tokens included", () => {
  beforeEach(() => setup());

  it("turnComplete stores tokensIn directly (server already adds output tokens)", () => {
    // The server (claude-provider) now includes output_tokens in tokensIn.
    // The frontend stores whatever value it receives.
    dispatch("session.turnComplete", {
      params: { reason: "end_turn", costUsd: null, tokensIn: 5000, tokensOut: 500, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(5000);
    // SDK runtime value (200K) is truthful and wins over the static map.
    // The new preference chain ranks SDK > static map > previous, so the
    // SDK-reported 200K is what gets stored.
    expect(ctx?.contextWindow).toBe(200_000);
  });
});

describe("context tracker — Fix 1: turnComplete skipped during compaction", () => {
  beforeEach(() =>
    setup({ isCompacting: true })
  );

  it("turnComplete during compaction does NOT update contextByThread", () => {
    dispatch("session.turnComplete", {
      params: { reason: "end_turn", costUsd: null, tokensIn: 195_000, tokensOut: 500, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    // Must stay empty — no flash of pre-compaction tokens
    expect(ctx).toBeUndefined();
  });

  it("turnComplete during compaction does NOT clear isCompactingByThread", () => {
    dispatch("session.turnComplete", {
      params: { reason: "end_turn", costUsd: null, tokensIn: 195_000, tokensOut: 500, contextWindow: 200_000 },
    });

    expect(getTestThreadIsCompacting(THREAD)).toBe(true);
  });
});

describe("context tracker — Fix 3: contextEstimate on compaction end", () => {
  beforeEach(() =>
    setup({
      isCompacting: true,
      context: { lastTokensIn: 0, contextWindow: 200_000 },
    })
  );

  it("contextEstimate updates contextByThread when NOT compacting", () => {
    // Simulate compaction ending: clear isCompacting on the thread record.
    resetThreadStoreForTests({
      currentThreadId: THREAD,
      runningThreadIds: new Set([THREAD]),
      records: new Map<string, ThreadRecord>([
        [THREAD, { ...createEmptyThreadRecord(), agentStartTime: Date.now() }],
      ]),
    });

    dispatch("session.contextEstimate", {
      params: { tokensIn: 100_000, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(100_000);
    expect(ctx?.contextWindow).toBe(200_000);
  });

  it("contextEstimate is ignored while compaction is still active", () => {
    // isCompactingByThread still set — estimate must not overwrite zero sentinel
    dispatch("session.contextEstimate", {
      params: { tokensIn: 100_000, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(0);
  });
});

describe("context tracker — Fix 4: live estimation during turn", () => {
  beforeEach(() =>
    setup({
      context: { lastTokensIn: 50_000, contextWindow: 200_000 },
    })
  );

  it("contextEstimate from toolResult accumulates into contextByThread", () => {
    dispatch("session.contextEstimate", {
      params: { tokensIn: 51_250, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(51_250);
  });

  it("multiple contextEstimates accumulate sequentially", () => {
    dispatch("session.contextEstimate", { params: { tokensIn: 51_000, contextWindow: 200_000 } });
    dispatch("session.contextEstimate", { params: { tokensIn: 52_500, contextWindow: 200_000 } });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(52_500);
  });

  it("turnComplete after tool calls overwrites estimate with authoritative value", () => {
    dispatch("session.contextEstimate", { params: { tokensIn: 52_500, contextWindow: 200_000 } });
    dispatch("session.turnComplete", {
      params: { reason: "end_turn", costUsd: null, tokensIn: 53_100, tokensOut: 600, contextWindow: 200_000 },
    });

    const ctx = getTestThreadContext(THREAD);
    expect(ctx?.lastTokensIn).toBe(53_100);
  });
});
