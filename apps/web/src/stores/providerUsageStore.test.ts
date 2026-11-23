// @vitest-environment jsdom
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageInfo, QuotaCategory } from "@mcode/contracts/providers/usage";
import { mergeProviderUsageSnapshot, type ProviderQuotaUsage } from "./provider-usage-snapshot";
import { observeQuotaUpdate, resetProviderUsageForTests, useProviderUsage } from "./providerUsageStore";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

const getProviderUsage = vi.mocked(mockTransport.getProviderUsage);

const READY_USAGE: ProviderQuotaUsage = {
  providerId: "claude",
  quotaCategories: [
    {
      label: "5-hour limit",
      used: 25,
      total: 100,
      remainingPercent: 0.75,
      resetDate: "2026-07-03T14:00:00.000Z",
      isUnlimited: false,
    },
  ],
  usageStatus: "ready",
  fetchedAt: "2026-07-03T12:00:00.000Z",
};

function fiveHour(usedPercent: number): QuotaCategory {
  return { label: "5-hour limit", used: usedPercent, total: 100, remainingPercent: 1 - usedPercent / 100, isUnlimited: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function usedPercentOf(usage: ProviderQuotaUsage | undefined): number | undefined {
  const category = usage?.quotaCategories[0];
  return category ? category.used : undefined;
}

beforeEach(() => {
  getProviderUsage.mockReset();
});

afterEach(() => {
  resetProviderUsageForTests();
  vi.useRealTimers();
});

describe("mergeProviderUsageSnapshot", () => {
  const now = Date.parse("2026-07-03T13:00:00.000Z");

  it("keeps known-good quota as stale when refresh becomes unavailable", () => {
    expect(
      mergeProviderUsageSnapshot(
        READY_USAGE,
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "unavailable",
          failedAt: "2026-07-03T13:00:00.000Z",
          diagnostic: "network unavailable",
        },
        now,
      ),
    ).toEqual({
      ...READY_USAGE,
      usageStatus: "stale",
      failedAt: "2026-07-03T13:00:00.000Z",
      diagnostic: "network unavailable",
    });
  });

  it("expires stale known-good quota after 24 hours but keeps the known billing mode", () => {
    expect(
      mergeProviderUsageSnapshot(
        { ...READY_USAGE, billingMode: "api_key" },
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "unavailable",
          failedAt: "2026-07-04T13:01:00.000Z",
          diagnostic: "network unavailable",
        },
        Date.parse("2026-07-04T13:01:00.000Z"),
      ),
    ).toEqual({
      providerId: "claude",
      quotaCategories: [],
      billingMode: "api_key",
      usageStatus: "unavailable",
      failedAt: "2026-07-04T13:01:00.000Z",
      diagnostic: "network unavailable",
    });
  });

  it("keeps explicit supported empty quota as ready-empty", () => {
    expect(
      mergeProviderUsageSnapshot(
        READY_USAGE,
        {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "ready-empty",
          fetchedAt: "2026-07-03T13:00:00.000Z",
        },
        now,
      ),
    ).toEqual({
      providerId: "claude",
      quotaCategories: [],
      usageStatus: "ready-empty",
      fetchedAt: "2026-07-03T13:00:00.000Z",
    });
  });

  it("successful refresh clears stale diagnostics", () => {
    expect(
      mergeProviderUsageSnapshot(
        { ...READY_USAGE, usageStatus: "stale", diagnostic: "old failure" },
        { ...READY_USAGE, fetchedAt: "2026-07-03T13:00:00.000Z" },
        now,
      ),
    ).toMatchObject({
      usageStatus: "ready",
      fetchedAt: "2026-07-03T13:00:00.000Z",
      failedAt: undefined,
      diagnostic: undefined,
    });
  });
});

describe("superseded usage requests", () => {
  function codexEventAt(usedPercent: number) {
    return {
      type: "quotaUpdate" as const,
      threadId: "thread-a",
      providerId: "codex",
      categories: [fiveHour(usedPercent)],
    };
  }

  it("discards a pending answer older than a Codex event and refreshes once after it", async () => {
    const pending = deferred<ProviderUsageInfo>();
    getProviderUsage.mockReturnValueOnce(pending.promise).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useProviderUsage("codex"));

    act(() => observeQuotaUpdate(codexEventAt(96)));
    act(() => observeQuotaUpdate(codexEventAt(96)));
    await act(async () => pending.resolve({ providerId: "codex", quotaCategories: [fiveHour(10)], usageStatus: "ready" }));

    expect(usedPercentOf(result.current)).toBe(96);
    expect(getProviderUsage).toHaveBeenCalledTimes(2);
  });

  it("discards a pending failure older than a Codex event without marking the quota stale", async () => {
    const pending = deferred<ProviderUsageInfo>();
    getProviderUsage.mockReturnValueOnce(pending.promise).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useProviderUsage("codex"));

    act(() => observeQuotaUpdate(codexEventAt(96)));
    await act(async () => pending.reject(new Error("offline")));

    expect(usedPercentOf(result.current)).toBe(96);
    expect(result.current?.usageStatus).toBe("ready");
    expect(getProviderUsage).toHaveBeenCalledTimes(2);
  });
});

describe("usage refresh timer", () => {
  it("does not tick a provider without quota categories, but ticks one with them", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-23T10:00:00.000Z") });
    getProviderUsage.mockImplementation(async (providerId: string) => {
      if (providerId === "codex") return { providerId, quotaCategories: [], usageStatus: "ready-empty", fetchedAt: new Date().toISOString() };
      if (providerId === "cursor") throw new Error("offline");
      return { providerId, quotaCategories: [fiveHour(30)], usageStatus: "ready", fetchedAt: new Date().toISOString() };
    });
    renderHook(() => {
      useProviderUsage("codex");
      useProviderUsage("cursor");
      useProviderUsage("claude");
    });
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60_000));

    const callsFor = (providerId: string) => getProviderUsage.mock.calls.filter(([id]) => id === providerId).length;
    expect(callsFor("codex")).toBe(1);
    expect(callsFor("cursor")).toBe(1);
    expect(callsFor("claude")).toBe(4);
  });
});
