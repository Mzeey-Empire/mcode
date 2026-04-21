/**
 * Skill and command scanning service.
 * Walks user, project, agent, and plugin directories looking for both
 * `skills/` (each subdirectory is a skill) and `commands/` (each .md file
 * is a command). Mirrors Claude Code's native discovery, extended to cover
 * Codex and Copilot provider directories.
 */

import { injectable } from "tsyringe";
import { readdirSync, readFileSync, existsSync, type Dirent } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { logger } from "@mcode/shared";
import type { SkillInfo, SkillSource, SkillDiagnostics } from "@mcode/contracts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

interface ScanContext {
  out: SkillInfo[];
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

/** Walk a flat skills directory: each subdir with `SKILL.md` is a skill. */
function scanSkillsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
  providers: string[],
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isDirectory()) continue;
    // Only treat a subdir as a skill if it has SKILL.md. Helper folders
    // (e.g., `_shared/`, `node_modules/`) and partially installed plugin
    // dirs would otherwise become empty slash-command entries.
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    ctx.out.push({
      name,
      description: readDescription(skillFile),
      kind: "skill",
      source,
      providers,
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
  providers: string[],
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const baseName = entry.name.slice(0, -3);
    const name = prefix ? `${prefix}:${baseName}` : baseName;
    ctx.out.push({
      name,
      description: readDescription(join(dir, entry.name)),
      kind: "command",
      source,
      providers,
    });
    ctx.diag.totalCommands++;
  }
}

/** Scan every known surface inside one plugin version directory. */
function scanPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
  providers: string[],
): void {
  // Both bare and `.claude`-prefixed shapes are observed in the wild.
  for (const sub of ["", ".claude"]) {
    const base = sub ? join(versionDir, sub) : versionDir;
    scanSkillsDir(ctx, join(base, "skills"), pluginName, "plugin", providers);
    scanCommandsDir(ctx, join(base, "commands"), pluginName, "plugin", providers);
  }
}

/** Numeric collator orders `2.1.0` before `10.0.0` instead of lexically.
 *  Avoids pulling in the `semver` dep just for plugin-cache version selection. */
const VERSION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Walk plugin cache: cache/<marketplace>/<plugin>/<version>/. */
function scanPluginCacheDir(ctx: ScanContext, cacheDir: string, providers: string[]): void {
  for (const mp of scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(cacheDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      const versions = scanDir(ctx, pluginDir)
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(VERSION_COLLATOR.compare);
      if (versions.length === 0) continue;
      scanPluginVersionDir(ctx, join(pluginDir, versions[versions.length - 1]), plugin.name, providers);
    }
  }
}

/** Walk plugin marketplaces: marketplaces/<marketplace>/<plugin>/. */
function scanPluginMarketplaceDir(ctx: ScanContext, marketplacesDir: string, providers: string[]): void {
  for (const mp of scanDir(ctx, marketplacesDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(marketplacesDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      // Marketplaces are unversioned — treat the plugin dir itself as the version dir.
      scanPluginVersionDir(ctx, pluginDir, plugin.name, providers);
    }
  }
}

/**
 * Resolve the Copilot user-level agents directory.
 * On Windows: %APPDATA%\GitHub Copilot\agents.
 * On macOS/Linux: ~/.config/github-copilot/agents.
 */
function copilotUserAgentsDir(): string {
  if (platform() === "win32") {
    const appData =
      process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "GitHub Copilot", "agents");
  }
  return join(homedir(), ".config", "github-copilot", "agents");
}

/** Drives a single directory scan: which path, what source, which providers, and whether to scan for skills, commands, or both. */
interface ScanRoot {
  path: string;
  source: SkillSource;
  providers: string[];
  /** "skills" scans for subdirs with SKILL.md, "commands" scans for *.md files, "both" does both. */
  kind: "skills" | "commands" | "both";
}

/** Build the ordered list of directories to scan for skills and commands. */
function buildScanRoots(home: string, cwd?: string): ScanRoot[] {
  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  const agentsDir = join(home, ".agents");

  const roots: ScanRoot[] = [
    // Claude ecosystem
    { path: join(claudeDir, "skills"), source: "user", providers: ["claude"], kind: "skills" },
    { path: join(claudeDir, "commands"), source: "user", providers: ["claude"], kind: "commands" },
    { path: join(claudeDir, ".agents", "skills"), source: "agent", providers: ["claude"], kind: "skills" },

    // Codex ecosystem
    { path: join(codexDir, "skills"), source: "user", providers: ["codex"], kind: "skills" },
    { path: join(codexDir, "commands"), source: "user", providers: ["codex"], kind: "commands" },

    // Cross-provider (.agents at home root — visible to Codex and Copilot but not Claude)
    { path: join(agentsDir, "skills"), source: "agent", providers: ["codex", "copilot"], kind: "skills" },
    { path: join(agentsDir, "commands"), source: "agent", providers: ["codex", "copilot"], kind: "commands" },

    // Copilot user-level agents
    { path: copilotUserAgentsDir(), source: "user", providers: ["copilot"], kind: "both" },
  ];

  if (cwd) {
    roots.push(
      // Claude project-level
      { path: join(cwd, ".claude", "skills"), source: "project", providers: ["claude"], kind: "skills" },
      { path: join(cwd, ".claude", "commands"), source: "project", providers: ["claude"], kind: "commands" },

      // Codex project-level
      { path: join(cwd, ".codex", "skills"), source: "project", providers: ["codex"], kind: "skills" },
      { path: join(cwd, ".codex", "commands"), source: "project", providers: ["codex"], kind: "commands" },

      // Cross-provider project-level
      { path: join(cwd, ".agents", "skills"), source: "project", providers: ["codex", "copilot"], kind: "skills" },
      { path: join(cwd, ".agents", "commands"), source: "project", providers: ["codex", "copilot"], kind: "commands" },

      // Copilot project-level agents
      { path: join(cwd, ".github", "agents"), source: "project", providers: ["copilot"], kind: "both" },
      { path: join(cwd, ".copilot", "agents"), source: "project", providers: ["copilot"], kind: "both" },
    );
  }

  return roots;
}

/** Discovers skills and commands across user, project, agent, and plugin sources. */
@injectable()
export class SkillService {
  /** Cached result; null means cold or invalidated. */
  private cache: SkillInfo[] | null = null;
  private cachedCwd: string | undefined = undefined;
  private subscribers = new Set<() => void>();

  /**
   * List discoverable skills and commands from disk.
   * When `providerId` is given, only entries whose `providers` array includes
   * that id are returned. Deduplication by name (higher-priority source wins)
   * is applied per filtered set, so the same name can coexist across providers.
   */
  list(cwd?: string, providerId?: string): SkillInfo[] {
    if (this.cache && this.cachedCwd === cwd) {
      return this.filterAndDedup(this.cache, providerId);
    }
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return this.filterAndDedup(result.items, providerId);
  }

  /** Force a full rescan and return per-path diagnostics. Provider-agnostic. */
  diagnose(cwd?: string): SkillDiagnostics {
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return result.diag;
  }

  /** Clear the in-memory cache and notify subscribers. Subscriber errors are isolated. */
  invalidate(): void {
    this.cache = null;
    this.cachedCwd = undefined;
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug("SkillService: subscriber threw", { message });
      }
    }
  }

  /** Register a callback fired whenever the cache is invalidated. Returns an unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Filter entries by provider, then deduplicate by name within the filtered
   * set using source priority (user > project > agent > plugin).
   * Deduplication is intentionally scoped to the filtered set so that a skill
   * named "deploy" can independently exist for both claude and codex.
   */
  private filterAndDedup(items: SkillInfo[], providerId?: string): SkillInfo[] {
    const filtered = providerId
      ? items.filter((s) => s.providers.includes(providerId))
      : items;

    const seen = new Map<string, SkillInfo>();
    for (const item of filtered) {
      const existing = seen.get(item.name);
      if (!existing || SOURCE_PRIORITY[item.source] < SOURCE_PRIORITY[existing.source]) {
        seen.set(item.name, item);
      }
    }
    return Array.from(seen.values());
  }

  private scan(cwd?: string): { items: SkillInfo[]; diag: SkillDiagnostics } {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const ctx: ScanContext = {
      out: [],
      diag: { scanned: [], errors: [], totalSkills: 0, totalCommands: 0 },
    };

    const roots = buildScanRoots(home, cwd);
    for (const root of roots) {
      if (root.kind === "skills" || root.kind === "both") {
        scanSkillsDir(ctx, root.path, "", root.source, root.providers);
      }
      if (root.kind === "commands" || root.kind === "both") {
        scanCommandsDir(ctx, root.path, "", root.source, root.providers);
      }
    }

    // Plugins remain Claude-scoped
    scanPluginCacheDir(ctx, join(claudeDir, "plugins", "cache"), ["claude"]);
    scanPluginMarketplaceDir(ctx, join(claudeDir, "plugins", "marketplaces"), ["claude"]);

    return { items: ctx.out, diag: ctx.diag };
  }
}
