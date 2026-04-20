/**
 * Watches Claude plugin and skills directories for changes and triggers
 * `SkillService` cache invalidation plus a `skills.changed` broadcast.
 *
 * Mirrors the debounce + fs.watch pattern of `GitWatcherService`.
 */

import { inject, injectable } from "tsyringe";
import { watch, existsSync, type FSWatcher } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "@mcode/shared";
import { broadcast } from "../transport/push";
import { SkillService } from "./skill-service";

const DEBOUNCE_MS = 200;

@injectable()
export class SkillWatcherService {
  private readonly watchers: FSWatcher[] = [];
  // Tracks which dirs already have a live watcher so repeated `watch(dir)`
  // calls (e.g. start() running twice across a stopAll(), or future code
  // paths that add overlapping roots) don't register duplicate FSWatchers
  // and fire the debounce timer twice per change.
  private readonly watchedDirs = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Tracks whether start() has run, separately from watcher count: a fresh
  // install with no `~/.claude/{skills,commands,plugins}` directories would
  // otherwise leave `watchers.length === 0`, defeating the idempotency guard.
  private started = false;

  constructor(
    @inject(SkillService) private readonly skills: SkillService,
  ) {}

  /**
   * Begin watching the standard Claude plugin and skill roots.
   * Idempotent: subsequent calls are no-ops until `stopAll()` resets state.
   */
  start(): void {
    if (this.started) {
      logger.debug("SkillWatcherService: start() ignored, already started", {
        watcherCount: this.watchers.length,
      });
      return;
    }
    this.started = true;
    const home = homedir();
    const roots = [
      join(home, ".claude", "skills"),
      join(home, ".claude", "commands"),
      join(home, ".claude", "plugins"),
    ];
    for (const root of roots) this.watch(root);
  }

  /** Begin watching one directory. No-op when the path is missing or already watched. */
  watch(dir: string): void {
    if (!existsSync(dir)) {
      logger.debug("SkillWatcherService: skip missing dir", { dir });
      return;
    }
    if (this.watchedDirs.has(dir)) {
      logger.debug("SkillWatcherService: skip already-watched dir", { dir });
      return;
    }
    try {
      const w = watch(dir, { recursive: true }, () => this.onChange(dir));
      this.attachErrorHandler(w, dir);
      this.watchers.push(w);
      this.watchedDirs.add(dir);
    } catch (err) {
      // Some platforms (BSD, network FS) reject recursive — fall back.
      const outerMessage = (err as Error).message;
      logger.debug("SkillWatcherService: recursive watch failed, falling back", {
        dir,
        message: outerMessage,
      });
      try {
        const w = watch(dir, () => this.onChange(dir));
        this.attachErrorHandler(w, dir);
        this.watchers.push(w);
        this.watchedDirs.add(dir);
      } catch (innerErr) {
        const message = (innerErr as Error).message;
        logger.warn("SkillWatcherService: watch failed", { dir, message });
      }
    }
  }

  /** Tear down every watcher (called from shutdown / tests). */
  stopAll(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
    this.watchedDirs.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /**
   * Wire a `error` handler so a single bad watcher cannot crash the process.
   * On error, log at debug, close the watcher, and drop it from the registry.
   */
  private attachErrorHandler(w: FSWatcher, dir: string): void {
    w.on("error", (err) => {
      logger.debug("SkillWatcherService: watcher error, dropping", {
        dir,
        message: err.message,
      });
      try {
        w.close();
      } catch {
        // ignore
      }
      const idx = this.watchers.indexOf(w);
      if (idx !== -1) this.watchers.splice(idx, 1);
      // Drop the dir from the dedup set too — otherwise a subsequent
      // watch() for the same path would silently no-op even though the
      // previous watcher is dead.
      this.watchedDirs.delete(dir);
    });
  }

  private onChange(dir: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      logger.debug("SkillWatcherService: debounced change", { dir });
      // A SkillService throw must not poison subsequent debounce cycles.
      try {
        this.skills.invalidate();
        broadcast("skills.changed", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug("SkillWatcherService: invalidate/broadcast failed", {
          dir,
          message,
        });
      }
    }, DEBOUNCE_MS);
  }
}
