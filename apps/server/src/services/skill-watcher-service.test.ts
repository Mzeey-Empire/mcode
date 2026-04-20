import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillService } from "./skill-service.js";
import { SkillWatcherService } from "./skill-watcher-service.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "skill-watch-"));
}

describe("SkillWatcherService", () => {
  let dir: string;
  let svc: SkillService;
  let watcher: SkillWatcherService;

  beforeEach(() => {
    dir = tmp();
    svc = new SkillService();
    watcher = new SkillWatcherService(svc);
  });

  afterEach(() => {
    watcher.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("invalidates the SkillService cache when a watched dir changes", async () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(dir);
    // Trigger a change event
    writeFileSync(join(dir, "skills", "marker.txt"), "x");

    await new Promise((r) => setTimeout(r, 350)); // > debounce window
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("debounces rapid changes into a single invalidation", async () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(dir);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, "skills", `f${i}.txt`), "x");
    }

    await new Promise((r) => setTimeout(r, 350));
    expect(invalidateSpy.mock.calls.length).toBe(1);
  });

  it("watch() on a missing directory does not throw", () => {
    expect(() => watcher.watch(join(dir, "does-not-exist"))).not.toThrow();
  });

  it("start() is idempotent: a second call from a clean state does not register duplicate watchers", () => {
    // Spy on the per-root watch() call rather than asserting on a snapshot
    // of watchers.length: this proves the FIRST start() actually ran (its
    // calls are observable on the spy) and the second start() short-circuited.
    // Pre-seeding watch(dir) would make both calls hit the fast-path and
    // leave the regression undetected.
    const watchSpy = vi.spyOn(watcher, "watch");

    watcher.start();
    const firstCallCount = watchSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    watcher.start();
    expect(watchSpy.mock.calls.length).toBe(firstCallCount);
  });
});
