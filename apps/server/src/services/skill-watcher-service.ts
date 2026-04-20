/**
 * Watches Claude plugin and skills directories for changes and triggers
 * `SkillService` cache invalidation plus a `skills.changed` broadcast.
 *
 * Mirrors the debounce + fs.watch pattern of `GitWatcherService`.
 */

import { injectable } from "tsyringe";
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
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly skills: SkillService) {}

  /**
   * Begin watching the standard Claude plugin and skill roots.
   * Idempotent: if any watchers are already registered, this is a no-op.
   * Call `stopAll()` first if you need to re-bootstrap.
   */
  start(): void {
    if (this.watchers.length > 0) {
      logger.debug("SkillWatcherService: start() ignored, watchers active", {
        count: this.watchers.length,
      });
      return;
    }
    const home = homedir();
    const roots = [
      join(home, ".claude", "skills"),
      join(home, ".claude", "commands"),
      join(home, ".claude", "plugins"),
    ];
    for (const root of roots) this.watch(root);
  }

  /** Begin watching one directory. No-op when the path is missing. */
  watch(dir: string): void {
    if (!existsSync(dir)) {
      logger.debug("SkillWatcherService: skip missing dir", { dir });
      return;
    }
    try {
      const w = watch(dir, { recursive: true }, () => this.onChange(dir));
      this.attachErrorHandler(w, dir);
      this.watchers.push(w);
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
