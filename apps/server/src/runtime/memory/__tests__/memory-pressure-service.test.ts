import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gc } from "bun";
import { getDefaultSettings } from "@mcode/contracts";
import { MemoryPressureService } from "../memory-pressure-service.js";
import type { RuntimeMemoryMeasurement } from "../runtime-memory-sampler.js";

vi.mock("bun", async (importOriginal) => ({
  ...await importOriginal<typeof import("bun")>(),
  gc: vi.fn(),
}));

const db = { run: vi.fn() } as unknown as import("bun:sqlite").Database;

function settingsWithHeapBudget(getHeapMb: () => number) {
  return {
    get: () => ({
      ...getDefaultSettings(),
      server: { memory: { heapMb: getHeapMb() } },
    }),
  };
}

function v8Measurement(usedBytes: number, budgetBytes: number): RuntimeMemoryMeasurement {
  return { source: "v8-heap", usedBytes, budgetBytes };
}

describe("MemoryPressureService", () => {
  let service: MemoryPressureService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new MemoryPressureService(db, settingsWithHeapBudget(() => 512));
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("emits warning and critical pressure levels from V8 heap ratios", () => {
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });

    service.markActive("thread-1");
    service.sampleActiveMemoryForTest(v8Measurement(81, 100));
    expect(service.currentPressure.level).toBe("warning");

    service.sampleActiveMemoryForTest(v8Measurement(91, 100));
    expect(service.currentPressure.level).toBe("critical");

    service.sampleActiveMemoryForTest(v8Measurement(10, 100));
    expect(service.currentPressure.level).toBe("normal");
    expect(levels).toEqual(expect.arrayContaining(["warning", "critical", "normal"]));
  });

  it("tracks per-turn high water and clears pressure after the last active turn", () => {
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));

    service.markIdle("thread-1");
    expect(service.currentPressure.level).toBe("warning");

    service.markIdle("thread-2");
    expect(service.currentPressure.level).toBe("normal");
  });

  it("requests collection once per pressure transition after notifying memory owners", () => {
    service.markActive("thread-1");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));
    vi.mocked(gc).mockClear();
    const collectionsAtNotification: number[] = [];
    service.onPressureChange(() => collectionsAtNotification.push(vi.mocked(gc).mock.calls.length));
    service.sampleActiveMemoryForTest(v8Measurement(95, 100));
    service.sampleActiveMemoryForTest(v8Measurement(96, 100));
    expect(collectionsAtNotification).toEqual([0]);
    expect(gc).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("notifies listeners when a turn becomes idle under sustained pressure", () => {
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));
    levels.length = 0;

    service.markIdle("thread-1");

    expect(service.currentPressure.level).toBe("warning");
    expect(levels).toEqual(["warning"]);
  });

  it("reclaims elevated pressure after completion callbacks without forcing collection during peer work", async () => {
    service.markActive("thread-1");
    service.markActive("thread-2");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));
    expect(gc).toHaveBeenCalledWith(false);
    vi.mocked(gc).mockClear();

    service.markIdle("thread-1");
    expect(gc).not.toHaveBeenCalled();
    service.markIdle("thread-2");
    expect(gc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(gc).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not force an idle collection when another turn starts before callbacks finish", async () => {
    service.markActive("thread-1");
    service.sampleActiveMemoryForTest(v8Measurement(85, 100));
    service.markIdle("thread-1");
    service.markActive("thread-2");
    vi.mocked(gc).mockClear();
    await vi.advanceTimersByTimeAsync(0);
    expect(gc).not.toHaveBeenCalled();
  });

  it("uses Bun RSS for thresholds, recovery, and updated settings", async () => {
    let heapMb = 256;
    const initialBudgetBytes = heapMb * 1024 * 1024;
    let rss = Math.floor(initialBudgetBytes * 0.8);
    service.dispose();
    service = new MemoryPressureService(db, settingsWithHeapBudget(() => heapMb));
    const levels: string[] = [];
    service.onPressureChange((snapshot) => {
      levels.push(snapshot.level);
    });
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, bun: "1.4.0" },
      memoryUsage: () => ({ rss }),
    });

    service.markActive("thread-1");
    expect(service.currentPressure.level).toBe("normal");

    rss = Math.ceil(initialBudgetBytes * 0.8);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure).toMatchObject({
      level: "warning",
      source: "process-rss",
      usedBytes: rss,
      budgetBytes: initialBudgetBytes,
    });
    expect(service.currentPressure.ratio).toBeGreaterThanOrEqual(0.8);

    rss = Math.ceil(initialBudgetBytes * 0.9);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure.level).toBe("critical");
    expect(service.currentPressure.ratio).toBeGreaterThanOrEqual(0.9);

    heapMb = 512;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.currentPressure.level).toBe("normal");
    expect(levels).toEqual(["warning", "critical", "normal"]);
  });

  it("runs warm-idle reclamation after all turns finish", async () => {
    service.markActive("thread-1");
    service.markIdle("thread-1");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(db.run).toHaveBeenCalledWith("PRAGMA optimize = 0x10002");
    expect(db.run).toHaveBeenCalledWith("PRAGMA shrink_memory");
  });

  it("uses the background cache budget and restores the active budget", async () => {
    service.markIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    service.markBackground();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.run).toHaveBeenCalledWith("PRAGMA cache_size = -500");

    service.markForeground();
    expect(db.run).toHaveBeenCalledWith("PRAGMA cache_size = -2048");
  });
});
