import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IUsageSource } from "@mcode/shared/usage";
import type { QuotaCategory } from "@mcode/contracts";
import { CompositeUsageSource } from "../composite-usage-source.js";

const stub = (id: string, result: QuotaCategory[] | null): IUsageSource => ({
  id,
  isAvailable: async () => result !== null,
  fetch: vi.fn(async () => result) as IUsageSource["fetch"],
});

describe("CompositeUsageSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sample: QuotaCategory[] = [
    { label: "5-hour limit", used: 1, total: 100, isUnlimited: false, remainingPercent: 0.99 },
  ];

  it("returns the first non-null source's result", async () => {
    const a = stub("a", sample);
    const b = stub("b", null);
    const composite = new CompositeUsageSource([a, b]);
    expect(await composite.fetch()).toEqual(sample);
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it("falls through when the first source returns null", async () => {
    const a = stub("a", null);
    const b = stub("b", sample);
    const composite = new CompositeUsageSource([a, b]);
    expect(await composite.fetch()).toEqual(sample);
  });

  it("returns null when every source returns null", async () => {
    const composite = new CompositeUsageSource([stub("a", null), stub("b", null)]);
    expect(await composite.fetch()).toBeNull();
  });

  it("caches successful results for 90 seconds", async () => {
    const a = stub("a", sample);
    const composite = new CompositeUsageSource([a]);

    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(89_000);
    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(await composite.fetch()).toEqual(sample);
    expect(a.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache null results", async () => {
    const a = stub("a", null);
    const composite = new CompositeUsageSource([a]);

    expect(await composite.fetch()).toBeNull();
    expect(await composite.fetch()).toBeNull();
    expect(a.fetch).toHaveBeenCalledTimes(2);
  });
});
