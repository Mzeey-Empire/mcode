/**
 * Skill and command scanning service.
 * Walks user, project, agent, and plugin directories looking for both
 * `skills/` (each subdirectory is a skill) and provider command directories.
 * Codex capabilities are intentionally excluded and enter through the provider catalog.
 */

import { injectable } from "tsyringe";
import type * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { logger } from "@mcode/shared";
import type { SkillInfo, SkillSource, SkillDiagnostics } from "@mcode/contracts/skills";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;
const NAME_RE = /^name:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

interface ScanContext {
  out: SkillInfo[];
  diag: SkillDiagnostics;
}

interface SkillFileMetadata {
  name: string | undefined;
  description: string;
}

/** Source priority: lower number = higher priority (overrides on duplicate name). */
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  user: 0,
  project: 1,
  agent: 2,
  plugin: 3,
};

/** Extract `description:` from the leading YAML frontmatter of a markdown file. */
async function readSkillFileMetadata(filePath: string): Promise<SkillFileMetadata> {
  try {
    return skillFileMetadata(await NodeFSPromises.readFile(filePath, "utf-8"));
  } catch {
    return { name: undefined, description: "" };
  }
}

function skillFileMetadata(content: string): SkillFileMetadata {
  const frontmatter = FRONTMATTER_RE.exec(content);
  if (!frontmatter) return { name: undefined, description: "" };
  const name = NAME_RE.exec(frontmatter[1]);
  const description = DESC_RE.exec(frontmatter[1]);
  return {
    name: name ? frontmatterValue(name) : undefined,
    description: description ? frontmatterValue(description) : "",
  };
}

function frontmatterValue(match: RegExpExecArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** Extract `description:` from the leading YAML frontmatter of a markdown file. */
async function readDescription(filePath: string): Promise<string> {
  return (await readSkillFileMetadata(filePath)).description;
}

/** Read a directory, recording each scan attempt in diagnostics. Never throws. */
async function scanDir(ctx: ScanContext, dir: string): Promise<NodeFS.Dirent[]> {
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSPromises.readdir(dir, { withFileTypes: true });
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

async function skillFileExists(filePath: string): Promise<boolean> {
  try {
    await NodeFSPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Walk a flat skills directory: each subdir with `SKILL.md` is a skill. */
async function scanSkillsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
  providers: string[],
): Promise<void> {
  for (const entry of await scanDir(ctx, dir)) {
    if (!entry.isDirectory()) continue;
    // Only treat a subdir as a skill if it has SKILL.md. Helper folders
    // (e.g., `_shared/`, `node_modules/`) and partially installed plugin
    // dirs would otherwise become empty slash-command entries.
    const skillFile = NodePath.join(dir, entry.name, "SKILL.md");
    if (!(await skillFileExists(skillFile))) continue;
    const metadata = await readSkillFileMetadata(skillFile);
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    ctx.out.push({
      name,
      description: metadata.description,
      kind: "skill",
      source,
      providers,
      nativeName: metadata.name || entry.name,
      path: skillFile,
    });
    ctx.diag.totalSkills++;
  }
}

/** Walk a flat commands directory: each *.md is a command. */
async function scanCommandsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
  providers: string[],
): Promise<void> {
  for (const entry of await scanDir(ctx, dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const baseName = entry.name.slice(0, -3);
    const name = prefix ? `${prefix}:${baseName}` : baseName;
    ctx.out.push({
      name,
      description: await readDescription(NodePath.join(dir, entry.name)),
      kind: "command",
      source,
      providers,
      nativeName: baseName,
      path: NodePath.join(dir, entry.name),
    });
    ctx.diag.totalCommands++;
  }
}

/**
 * Scan every known surface inside one plugin version directory.
 * Plugins live under `~/.claude/plugins/` — Claude's own infrastructure — so they
 * are always tagged with whatever `providers` the caller passes (always `["claude"]`).
 * Provider-specific subdirs authored by the plugin (`.agents/`, `.codex/`, etc.) are
 * intentionally ignored here: a plugin installed through Claude's system does not
 * automatically become available to other providers. Cross-provider access requires
 * the user to place skills in the provider-specific user directories (`~/.codex/`,
 * `~/.agents/`, etc.) explicitly.
 */
async function scanPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
  providers: string[],
): Promise<void> {
  // Both bare and `.claude`-prefixed shapes are observed in the wild.
  for (const sub of ["", ".claude"]) {
    const base = sub ? NodePath.join(versionDir, sub) : versionDir;
    await scanSkillsDir(ctx, NodePath.join(base, "skills"), pluginName, "plugin", providers);
    await scanCommandsDir(ctx, NodePath.join(base, "commands"), pluginName, "plugin", providers);
  }
}

/** Numeric collator orders `2.1.0` before `10.0.0` instead of lexically.
 *  Avoids pulling in the `semver` dep just for plugin-cache version selection. */
const VERSION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Walk plugin cache: cache/<marketplace>/<plugin>/<version>/. */
async function scanPluginCacheDir(ctx: ScanContext, cacheDir: string, providers: string[]): Promise<void> {
  for (const mp of await scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = NodePath.join(cacheDir, mp.name);
    for (const plugin of await scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = NodePath.join(mpDir, plugin.name);
      const versions = (await scanDir(ctx, pluginDir))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(VERSION_COLLATOR.compare);
      if (versions.length === 0) continue;
      await scanPluginVersionDir(ctx, NodePath.join(pluginDir, versions[versions.length - 1]), plugin.name, providers);
    }
  }
}

/**
 * Walk plugin marketplaces: each marketplace directory IS the plugin version root.
 *
 * Marketplace installs are git-checkout style repos where the marketplace dir itself
 * contains the plugin content (skills/, commands/, .agents/, .claude/, etc.).
 * They do NOT follow a <marketplace>/<plugin>/<version>/ nesting — the marketplace
 * name IS the plugin name, and the directory IS the version dir. Treating subdirs
 * as separate "plugins" would produce wrong prefixes (e.g. ".agents:adapt" instead
 * of "impeccable:adapt") and duplicate entries alongside the cache scan.
 */
async function scanPluginMarketplaceDir(ctx: ScanContext, marketplacesDir: string, providers: string[]): Promise<void> {
  for (const mp of await scanDir(ctx, marketplacesDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = NodePath.join(marketplacesDir, mp.name);
    // Use the marketplace name as the plugin prefix; the dir itself is the version dir.
    await scanPluginVersionDir(ctx, mpDir, mp.name, providers);
  }
}

function pathSegmentsUnder(root: string, filePath: string): string[] | null {
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const fileNorm = filePath.replace(/\\/g, "/");
  const rootLower = rootNorm.toLowerCase();
  const fileLower = fileNorm.toLowerCase();
  if (fileLower !== rootLower && !fileLower.startsWith(`${rootLower}/`)) return null;
  return fileNorm.slice(rootNorm.length + 1).split("/").filter(Boolean);
}

/** Returns the Codex plugin name encoded in a skill path, when the path has one. */
export function codexPluginNameFromSkillPath(filePath: string, home = NodeOS.homedir()): string | undefined {
  const cacheSegments = pathSegmentsUnder(NodePath.join(home, ".codex", "plugins", "cache"), filePath);
  if (cacheSegments && cacheSegments.length >= 2) return cacheSegments[1];

  const runtimeSegments = pathSegmentsUnder(
    NodePath.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "plugins"),
    filePath,
  );
  if (runtimeSegments) {
    const pluginsIdx = runtimeSegments.findIndex((segment) => segment.toLowerCase() === "plugins");
    const pluginName = pluginsIdx >= 0 ? runtimeSegments[pluginsIdx + 1] : undefined;
    if (pluginName) return pluginName;
  }

  return undefined;
}

/**
 * Scan one Cursor plugin install directory (hash-named version folder).
 * Extends Claude-shaped layouts with Cursor-native `.cursor/skills`,
 * `.cursor/commands`, and peer `workflow-skills/` trees.
 */
async function scanCursorPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
  providers: string[],
): Promise<void> {
  await scanPluginVersionDir(ctx, versionDir, pluginName, providers);
  const cursorBase = NodePath.join(versionDir, ".cursor");
  await scanSkillsDir(ctx, NodePath.join(cursorBase, "skills"), pluginName, "plugin", providers);
  await scanCommandsDir(ctx, NodePath.join(cursorBase, "commands"), pluginName, "plugin", providers);
  await scanSkillsDir(ctx, NodePath.join(versionDir, "workflow-skills"), pluginName, "plugin", providers);
  await scanSkillsDir(ctx, NodePath.join(cursorBase, "workflow-skills"), pluginName, "plugin", providers);
}

/**
 * Walk Cursor plugin caches (`~/.cursor/plugins/cache`, `local`): cache/<mp>/<plugin>/<hash>/.
 * Version dirs are opaque hashes (not semver); pick the newest by directory mtime.
 */
async function scanCursorPluginCacheDir(ctx: ScanContext, cacheDir: string, providers: string[]): Promise<void> {
  for (const mp of await scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    await scanCursorPluginMarketplace(ctx, NodePath.join(cacheDir, mp.name), providers);
  }
}

async function scanCursorPluginMarketplace(ctx: ScanContext, marketplaceDir: string, providers: string[]): Promise<void> {
  for (const plugin of await scanDir(ctx, marketplaceDir)) {
    if (!plugin.isDirectory()) continue;
    await scanCursorPlugin(ctx, NodePath.join(marketplaceDir, plugin.name), plugin.name, providers);
  }
}

async function scanCursorPlugin(ctx: ScanContext, pluginDir: string, pluginName: string, providers: string[]): Promise<void> {
  const newestVersion = await newestCursorPluginVersion(pluginDir, await scanDir(ctx, pluginDir));
  if (newestVersion) {
    await scanCursorPluginVersionDir(ctx, NodePath.join(pluginDir, newestVersion), pluginName, providers);
  }
}

async function newestCursorPluginVersion(pluginDir: string, entries: NodeFS.Dirent[]): Promise<string | undefined> {
  let newest: { name: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = await cursorPluginVersionMtime(pluginDir, entry.name);
    if (!newest || candidate.mtime > newest.mtime) newest = candidate;
  }
  return newest?.name;
}

async function cursorPluginVersionMtime(pluginDir: string, name: string): Promise<{ name: string; mtime: number }> {
  try {
    return { name, mtime: (await NodeFSPromises.stat(NodePath.join(pluginDir, name))).mtimeMs };
  } catch {
    // A cache entry can disappear between directory listing and stat.
    return { name, mtime: 0 };
  }
}

/**
 * Resolve the Copilot user-level agents directory.
 *
 * @returns The platform-specific path to Copilot's user-level agents directory.
 *   - Windows: `%APPDATA%\GitHub Copilot\agents`
 *   - macOS/Linux: `~/.config/github-copilot/agents`
 */
export function copilotUserAgentsDir(): string {
  if (NodeOS.platform() === "win32") {
    const appData =
      process.env["APPDATA"] ?? NodePath.join(NodeOS.homedir(), "AppData", "Roaming");
    return NodePath.join(appData, "GitHub Copilot", "agents");
  }
  return NodePath.join(NodeOS.homedir(), ".config", "github-copilot", "agents");
}

/** Drives a single directory scan: which path, what source, which providers, and whether to scan for skills, commands, or both. */
interface ScanRoot {
  path: string;
  source: SkillSource;
  providers: string[];
  /** "skills" scans for subdirs with SKILL.md, "commands" scans for *.md files, "both" does both. */
  kind: "skills" | "commands" | "both";
  /** Optional namespace prefix applied to markdown command files. */
  prefix?: string;
}

/** Build the ordered list of directories to scan for skills and commands. */
function buildScanRoots(home: string, cwd?: string): ScanRoot[] {
  const claudeDir = NodePath.join(home, ".claude");
  const copilotDir = NodePath.join(home, ".copilot");
  const cursorDir = NodePath.join(home, ".cursor");

  const roots: ScanRoot[] = [
    // Claude ecosystem
    { path: NodePath.join(claudeDir, "skills"), source: "user", providers: ["claude"], kind: "skills" },
    { path: NodePath.join(claudeDir, "commands"), source: "user", providers: ["claude"], kind: "commands" },
    { path: NodePath.join(claudeDir, ".agents", "skills"), source: "agent", providers: ["claude"], kind: "skills" },

    // Copilot ecosystem
    { path: NodePath.join(copilotDir, "skills"), source: "user", providers: ["copilot"], kind: "skills" },
    { path: NodePath.join(copilotDir, "commands"), source: "user", providers: ["copilot"], kind: "commands" },

    // Cursor CLI ecosystem (cursor-agent discovers workspace rules separately; these roots drive Mcode UI listing)
    { path: NodePath.join(cursorDir, "skills"), source: "user", providers: ["cursor"], kind: "skills" },
    { path: NodePath.join(cursorDir, "commands"), source: "user", providers: ["cursor"], kind: "commands" },

    // Copilot user-level agents (OS-native config path)
    { path: copilotUserAgentsDir(), source: "user", providers: ["copilot"], kind: "both" },
  ];

  if (cwd) {
    roots.push(
      // Claude project-level
      { path: NodePath.join(cwd, ".claude", "skills"), source: "project", providers: ["claude"], kind: "skills" },
      { path: NodePath.join(cwd, ".claude", "commands"), source: "project", providers: ["claude"], kind: "commands" },

      // Copilot project-level agents
      { path: NodePath.join(cwd, ".github", "agents"), source: "project", providers: ["copilot"], kind: "both" },
      { path: NodePath.join(cwd, ".copilot", "agents"), source: "project", providers: ["copilot"], kind: "both" },

      // Cursor project-level
      { path: NodePath.join(cwd, ".cursor", "skills"), source: "project", providers: ["cursor"], kind: "skills" },
      { path: NodePath.join(cwd, ".cursor", "commands"), source: "project", providers: ["cursor"], kind: "commands" },
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
  private scanGeneration = 0;
  private pendingScans = new Map<string | undefined, ReturnType<SkillService["scan"]>>();
  private subscribers = new Set<() => void>();

  /**
   * List discoverable skills and commands from disk.
   * When `providerId` is given, only entries whose `providers` array includes
   * that id are returned. Deduplication by name (higher-priority source wins)
   * is applied per filtered set, so the same name can coexist across providers.
   */
  async list(cwd?: string, providerId?: string): Promise<SkillInfo[]> {
    if (this.cache && this.cachedCwd === cwd) {
      return this.filterAndDedup(this.cache, providerId);
    }
    let pending = this.pendingScans.get(cwd);
    if (!pending) {
      pending = this.scanAndCache(cwd);
      this.pendingScans.set(cwd, pending);
    }
    try {
      const result = await pending;
      return this.filterAndDedup(result.items, providerId);
    } finally {
      if (this.pendingScans.get(cwd) === pending) this.pendingScans.delete(cwd);
    }
  }

  /** Force a full rescan and return per-path diagnostics. Provider-agnostic. */
  async diagnose(cwd?: string): Promise<SkillDiagnostics> {
    const result = await this.scanAndCache(cwd);
    return result.diag;
  }

  private async scanAndCache(cwd?: string): ReturnType<SkillService["scan"]> {
    const generation = this.scanGeneration;
    const result = await this.scan(cwd);
    if (generation === this.scanGeneration) {
      this.cache = result.items;
      this.cachedCwd = cwd;
    }
    return result;
  }

  /** Clear the in-memory cache and notify subscribers. Subscriber errors are isolated. */
  invalidate(): void {
    this.scanGeneration++;
    this.pendingScans.clear();
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

  private async scan(cwd?: string): Promise<{ items: SkillInfo[]; diag: SkillDiagnostics }> {
    const home = NodeOS.homedir();
    const claudeDir = NodePath.join(home, ".claude");
    const cursorDir = NodePath.join(home, ".cursor");
    const ctx: ScanContext = {
      out: [],
      diag: { scanned: [], errors: [], totalSkills: 0, totalCommands: 0 },
    };

    const roots = buildScanRoots(home, cwd);
    for (const root of roots) {
      if (root.kind === "skills" || root.kind === "both") {
        await scanSkillsDir(ctx, root.path, "", root.source, root.providers);
      }
      if (root.kind === "commands" || root.kind === "both") {
        await scanCommandsDir(ctx, root.path, root.prefix ?? "", root.source, root.providers);
      }
    }

    // Claude plugin infrastructure (semver-sorted cache + marketplace checkouts)
    await scanPluginCacheDir(ctx, NodePath.join(claudeDir, "plugins", "cache"), ["claude"]);
    await scanPluginMarketplaceDir(ctx, NodePath.join(claudeDir, "plugins", "marketplaces"), ["claude"]);

    // Cursor plugin installs (mtime-selected hash dirs under ~/.cursor/plugins)
    await scanCursorPluginCacheDir(ctx, NodePath.join(cursorDir, "plugins", "cache"), ["cursor"]);
    await scanCursorPluginCacheDir(ctx, NodePath.join(cursorDir, "plugins", "local"), ["cursor"]);

    return { items: ctx.out, diag: ctx.diag };
  }
}
