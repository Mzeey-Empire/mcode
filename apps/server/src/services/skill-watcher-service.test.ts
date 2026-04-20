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

  it("watch() dedupes by directory path: a second call for the same dir is a no-op", async () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    const target = join(dir, "skills");
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(target);
    watcher.watch(target);

    // Trigger one fs change. With dedup the debounced invalidate fires once;
    // without dedup, two FSWatchers would each schedule the timer (the second
    // resets it), and the eventual single timer fire would still call
    // invalidate once — so call count alone is insufficient. The real
    // assertion is that we never registered a second underlying watcher.
    writeFileSync(join(target, "marker.txt"), "x");
    await new Promise((r) => setTimeout(r, 350));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // stopAll() must close every registered watcher; if dedup leaked a second
    // watcher into the array, this assertion would still pass but the dir
    // would remain watched after stopAll(). Verify via internal state.
    expect((watcher as unknown as { watchers: unknown[] }).watchers.length).toBe(1);
  });

  it("start() is idempotent: a second call from a clean state does not call watch() again", () => {
    // Spy on watch() so the assertion is independent of which `~/.claude/*`
    // subdirs happen to exist on the host (CI typically has none, in which
    // case watch() short-circuits and never pushes to `watchers`). Counting
    // watch() invocations directly proves the `started` guard, not the
    // downstream watcher-registration side effect.
    const watchSpy = vi.spyOn(watcher, "watch");

    watcher.start();
    const firstCallCount = watchSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    watcher.start();
    expect(watchSpy.mock.calls.length).toBe(firstCallCount);
  });
});
