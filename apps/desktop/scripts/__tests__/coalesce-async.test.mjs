import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeCoalescedAsync } from "../coalesce-async.mjs";

describe("makeCoalescedAsync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once after the debounce window when triggered a single time", async () => {
    const fn = vi.fn(async () => {});
    const trigger = makeCoalescedAsync(fn, 100);

    trigger();
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces synchronous bursts into a single run", async () => {
    const fn = vi.fn(async () => {});
    const trigger = makeCoalescedAsync(fn, 100);

    trigger();
    trigger();
    trigger();
    trigger();

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("queues at most one follow-up when triggered DURING an in-flight run", async () => {
    // This is the key regression test: in dev-electron.mjs we observed multiple
    // restarts because tsc emitted files while esbuild was still bundling, and
    // each event scheduled an independent build.
    let resolveFirst;
    const firstRunPromise = new Promise((r) => {
      resolveFirst = r;
    });
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) await firstRunPromise; // simulate long-running build
    });
    const trigger = makeCoalescedAsync(fn, 100);

    // 1. First trigger → first run starts after debounce
    trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // 2. While first run is in flight, three more triggers arrive
    trigger();
    trigger();
    trigger();

    // No new build should have started yet — still in the first run
    expect(fn).toHaveBeenCalledTimes(1);

    // 3. First run finishes — should schedule EXACTLY ONE follow-up,
    //    debounced by the same window.
    resolveFirst();
    await Promise.resolve(); // let the finally handler run
    await Promise.resolve(); // and the nested setTimeout schedule
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // 4. Wait some more — no extra runs should happen.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("survives the wrapped function throwing without leaving running=true", async () => {
    let throwOnFirst = true;
    const fn = vi.fn(async () => {
      if (throwOnFirst) {
        throwOnFirst = false;
        throw new Error("boom");
      }
    });
    const trigger = makeCoalescedAsync(fn, 100);

    trigger();
    await vi.advanceTimersByTimeAsync(100);
    // First run threw, but state should be reset so the next trigger works.
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-debounces a burst that arrives between two completed runs", async () => {
    const fn = vi.fn(async () => {});
    const trigger = makeCoalescedAsync(fn, 100);

    trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // First run is done. New burst arrives — should debounce as a fresh
    // window, not run immediately.
    trigger();
    trigger();
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
