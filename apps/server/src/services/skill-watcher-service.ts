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

  /** Begin watching the standard Claude plugin and skill roots. */
  start(): void {
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
      this.watchers.push(w);
    } catch (err) {
      // Some platforms (BSD, network FS) reject recursive — fall back.
      try {
        const w = watch(dir, () => this.onChange(dir));
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

  private onChange(dir: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      logger.debug("SkillWatcherService: debounced change", { dir });
      this.skills.invalidate();
      broadcast("skills.changed", {});
    }, DEBOUNCE_MS);
  }
}
