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

  it("start() is idempotent: a second call does not register duplicate watchers", async () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    // Seed one watcher manually so start()'s idempotency guard
    // (`watchers.length > 0` short-circuit) trips on both subsequent calls.
    // Without the guard, each start() call would push additional FSWatcher
    // instances rooted at ~/.claude paths, polluting global fs handles.
    watcher.watch(dir);
    const countAfterSeed = (watcher as unknown as { watchers: unknown[] }).watchers.length;

    watcher.start();
    watcher.start();

    const countAfterStarts = (watcher as unknown as { watchers: unknown[] }).watchers.length;
    expect(countAfterStarts).toBe(countAfterSeed);

    // A single fs change must still result in exactly one invalidation
    // (regression guard: duplicate watchers would still collapse under the
    // shared debounce timer, but the watcher-count assertion above catches
    // the leak directly).
    writeFileSync(join(dir, "skills", "marker.txt"), "x");
    await new Promise((r) => setTimeout(r, 350));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});
