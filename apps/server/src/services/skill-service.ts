/**
 * Skill and command scanning service.
 * Walks user, project, agent, and plugin directories looking for both
 * `skills/` (each subdirectory is a skill) and `commands/` (each .md file
 * is a command). Mirrors Claude Code's native discovery.
 */

import { injectable } from "tsyringe";
import { readdirSync, readFileSync, type Dirent } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "@mcode/shared";
import type { SkillInfo, SkillSource, SkillDiagnostics } from "@mcode/contracts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

interface ScanContext {
  out: Map<string, SkillInfo>;
  diag: SkillDiagnostics;
}

/** Source priority: lower number = higher priority (overrides on duplicate name). */
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  user: 0,
  project: 1,
  agent: 2,
  plugin: 3,
};

/** Extract `description:` from the leading YAML frontmatter of a markdown file. */
function readDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fm = FRONTMATTER_RE.exec(content);
    if (!fm) return "";
    const desc = DESC_RE.exec(fm[1]);
    if (!desc) return "";
    return (desc[1] ?? desc[2] ?? desc[3] ?? "").trim();
  } catch {
    return "";
  }
}

/** Read a directory, recording each scan attempt in diagnostics. Never throws. */
function scanDir(ctx: ScanContext, dir: string): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
    ctx.diag.scanned.push({ path: dir, existed: true, entries: entries.length });
    return entries;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      ctx.diag.scanned.push({ path: dir, existed: false, entries: 0 });
    } else {
      ctx.diag.errors.push({ path: dir, message: error.message });
      logger.debug("SkillService: scan error", { dir, message: error.message });
    }
    return [];
  }
}

/** Set entry only if absent OR the new source has higher priority than the existing one. */
function setIfHigherPriority(out: Map<string, SkillInfo>, info: SkillInfo): void {
  const existing = out.get(info.name);
  if (!existing || SOURCE_PRIORITY[info.source] < SOURCE_PRIORITY[existing.source]) {
    out.set(info.name, info);
  }
}

/** Walk a flat skills directory: each subdir with `SKILL.md` is a skill. */
function scanSkillsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isDirectory()) continue;
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    setIfHigherPriority(ctx.out, {
      name,
      description: readDescription(join(dir, entry.name, "SKILL.md")),
      kind: "skill",
      source,
    });
    ctx.diag.totalSkills++;
  }
}

/** Walk a flat commands directory: each *.md is a command. */
function scanCommandsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const baseName = entry.name.slice(0, -3);
    const name = prefix ? `${prefix}:${baseName}` : baseName;
    setIfHigherPriority(ctx.out, {
      name,
      description: readDescription(join(dir, entry.name)),
      kind: "command",
      source,
    });
    ctx.diag.totalCommands++;
  }
}

/** Scan every known surface inside one plugin version directory. */
function scanPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
): void {
  // Both bare and `.claude`-prefixed shapes are observed in the wild.
  for (const sub of ["", ".claude"]) {
    const base = sub ? join(versionDir, sub) : versionDir;
    scanSkillsDir(ctx, join(base, "skills"), pluginName, "plugin");
    scanCommandsDir(ctx, join(base, "commands"), pluginName, "plugin");
  }
}

/** Walk plugin cache: cache/<marketplace>/<plugin>/<version>/. */
function scanPluginCacheDir(ctx: ScanContext, cacheDir: string): void {
  for (const mp of scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(cacheDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      const versions = scanDir(ctx, pluginDir)
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      if (versions.length === 0) continue;
      scanPluginVersionDir(ctx, join(pluginDir, versions[versions.length - 1]), plugin.name);
    }
  }
}

/** Walk plugin marketplaces: marketplaces/<marketplace>/<plugin>/. */
function scanPluginMarketplaceDir(ctx: ScanContext, marketplacesDir: string): void {
  for (const mp of scanDir(ctx, marketplacesDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(marketplacesDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      // Marketplaces are unversioned — treat the plugin dir itself as the version dir.
      scanPluginVersionDir(ctx, pluginDir, plugin.name);
    }
  }
}

/** Discovers skills and commands across user, project, agent, and plugin sources. */
@injectable()
export class SkillService {
  /** Cached result; null means cold or invalidated. */
  private cache: SkillInfo[] | null = null;
  private cachedCwd: string | undefined = undefined;
  private subscribers = new Set<() => void>();

  /**
   * List every skill and command discoverable from disk.
   * Sources, in priority order (higher overrides lower for duplicate names):
   * 1. `~/.claude/skills/` (user)
   * 2. `~/.claude/commands/` (user)
   * 3. `<cwd>/.claude/skills/` (project)
   * 4. `<cwd>/.claude/commands/` (project)
   * 5. `~/.claude/.agents/skills/` (agent)
   * 6. `~/.claude/plugins/cache/...` (plugin)
   * 7. `~/.claude/plugins/marketplaces/...` (plugin)
   */
  list(cwd?: string): SkillInfo[] {
    if (this.cache && this.cachedCwd === cwd) return this.cache;
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return result.items;
  }

  /** Force a full rescan and return per-path diagnostics. */
  diagnose(cwd?: string): SkillDiagnostics {
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return result.diag;
  }

  /** Clear the in-memory cache and notify subscribers. */
  invalidate(): void {
    this.cache = null;
    this.cachedCwd = undefined;
    for (const cb of this.subscribers) cb();
  }

  /** Register a callback fired whenever the cache is invalidated. Returns an unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private scan(cwd?: string): { items: SkillInfo[]; diag: SkillDiagnostics } {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const ctx: ScanContext = {
      out: new Map(),
      diag: { scanned: [], errors: [], totalSkills: 0, totalCommands: 0 },
    };

    scanSkillsDir(ctx, join(claudeDir, "skills"), "", "user");
    scanCommandsDir(ctx, join(claudeDir, "commands"), "", "user");

    if (cwd) {
      scanSkillsDir(ctx, join(cwd, ".claude", "skills"), "", "project");
      scanCommandsDir(ctx, join(cwd, ".claude", "commands"), "", "project");
    }

    scanSkillsDir(ctx, join(claudeDir, ".agents", "skills"), "", "agent");
    scanPluginCacheDir(ctx, join(claudeDir, "plugins", "cache"));
    scanPluginMarketplaceDir(ctx, join(claudeDir, "plugins", "marketplaces"));

    return { items: Array.from(ctx.out.values()), diag: ctx.diag };
  }
}
