/**
 * Resolves the icon each project shows: the user's chosen file, a favicon found
 * in common places, or nothing (the client draws a monogram). Always reads the
 * workspace root so every worktree of a project shows the same icon.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { WORKSPACE_IMAGE_MAX_BYTES, type ProjectIcon, type Workspace } from "@mcode/contracts";
import type { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { readWorkspaceFileBytes, validateWorkspaceFilePath, WorkspaceFileNotFoundError } from "../files/workspace-file-access.js";

const CACHE_TTL_MS = 60_000;
const MAX_PROBES_PER_RESOLVE = 32;
const HTML_READ_MAX_BYTES = 256 * 1024;

/** Root-relative favicon locations, in the order a project most likely keeps its icon. */
const WELL_KNOWN_ICON_PATHS = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "public/icon.svg", "public/icon.png", "public/logo.svg", "public/logo.png",
  "app/favicon.ico", "app/icon.svg", "app/icon.png",
  "src/app/favicon.ico", "src/app/icon.png",
  "static/favicon.ico", "static/favicon.png",
  "assets/icon.png", "assets/logo.svg", "assets/logo.png",
  "logo.svg",
] as const;

/** HTML entry points whose `<link rel="icon">` names the favicon when no well-known file exists. */
const ICON_HTML_PATHS = ["index.html", "public/index.html", "src/index.html"] as const;

const ICON_EXTENSIONS: ReadonlySet<string> = new Set([".svg", ".png", ".ico", ".webp", ".jpg", ".jpeg", ".gif", ".avif"]);

/** Why a path cannot be a project icon; `code` reaches the client through the RPC router. */
export class ProjectIconError extends Error {
  constructor(readonly code: "invalid_icon_path" | "workspace_not_found", message: string) {
    super(message);
  }
}

/** Dependencies for {@link ProjectIconService}; `now` is injectable so tests can expire the cache. */
export interface ProjectIconServiceOptions {
  workspaces: Pick<WorkspaceRepo, "findById" | "setIconPath">;
  platform: NodeJS.Platform;
  now?: () => number;
}

type IconFile = { path: string; version: string };

/**
 * Icon rules layered on the shared workspace path validator. The validator
 * accepts `\` as a separator, but stored icon paths are POSIX, so a backslash
 * is rejected here rather than silently normalized.
 */
function iconRuleViolation(requestedPath: string, size: number): string | null {
  if (requestedPath.includes("\\")) return "Icon paths use forward slashes.";
  if (!ICON_EXTENSIONS.has(NodePath.extname(requestedPath).toLowerCase())) {
    return "Choose an SVG, PNG, ICO, WebP, JPEG, GIF or AVIF file.";
  }
  if (size > WORKSPACE_IMAGE_MAX_BYTES.icon) return "Icon files must be 2 MB or smaller.";
  return null;
}

/** Builds the shared image route URL; `v` changes the URL whenever the file changes. */
function projectIconUrl(workspaceId: string, file: IconFile): string {
  const query = new URLSearchParams({ path: file.path, use: "icon", v: file.version });
  return `/workspace-images/${encodeURIComponent(workspaceId)}?${query}`;
}

/** Resolves, caches, and stores project icons. */
export class ProjectIconService {
  private readonly cache = new Map<string, { icon: ProjectIcon; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: ProjectIconServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Returns icons for known, non-deleted workspaces; unknown ids are omitted. */
  async resolve(workspaceIds: readonly string[]): Promise<ProjectIcon[]> {
    const icons: ProjectIcon[] = [];
    for (const id of new Set(workspaceIds)) {
      const workspace = this.options.workspaces.findById(id);
      if (workspace) icons.push(await this.resolveCached(workspace));
    }
    return icons;
  }

  /** Stores a chosen icon path (or null for automatic) and returns the fresh icon. */
  async set(workspaceId: string, iconPath: string | null): Promise<ProjectIcon> {
    const workspace = this.options.workspaces.findById(workspaceId);
    if (!workspace) throw new ProjectIconError("workspace_not_found", "This project no longer exists.");
    const stored = iconPath === null ? null : (await readIconFile(workspace.path, iconPath, this.options.platform)).path;
    const updated = await this.options.workspaces.setIconPath(workspaceId, stored);
    if (!updated) throw new ProjectIconError("workspace_not_found", "This project no longer exists.");
    this.cache.delete(workspaceId);
    return this.resolveCached(updated);
  }

  private async resolveCached(workspace: Workspace): Promise<ProjectIcon> {
    const cached = this.cache.get(workspace.id);
    if (cached && cached.expiresAt > this.now()) return cached.icon;
    const icon = await resolveIcon(workspace, this.options.platform);
    this.cache.set(workspace.id, { icon, expiresAt: this.now() + CACHE_TTL_MS });
    return icon;
  }
}

async function resolveIcon(workspace: Workspace, platform: NodeJS.Platform): Promise<ProjectIcon> {
  const probes = { remaining: MAX_PROBES_PER_RESOLVE };
  const workspaceId = workspace.id;
  if (workspace.icon_path !== null) {
    const chosen = await probeIconFile(workspace.path, workspace.icon_path, platform, probes);
    if (chosen) return { workspaceId, source: "chosen", chosenMissing: false, ...chosen, url: projectIconUrl(workspaceId, chosen) };
  }
  const chosenMissing = workspace.icon_path !== null;
  for await (const candidate of automaticCandidates(workspace.path, platform, probes)) {
    const found = await probeIconFile(workspace.path, candidate, platform, probes);
    if (found) return { workspaceId, source: "automatic", chosenMissing, ...found, url: projectIconUrl(workspaceId, found) };
  }
  return { workspaceId, source: "none", chosenMissing };
}

async function* automaticCandidates(rootDir: string, platform: NodeJS.Platform, probes: { remaining: number }): AsyncGenerator<string> {
  yield* WELL_KNOWN_ICON_PATHS;
  for (const htmlPath of ICON_HTML_PATHS) {
    if (probes.remaining <= 0) return;
    probes.remaining -= 1;
    const html = await readHtmlHead(rootDir, htmlPath, platform);
    if (html === null) continue;
    for (const href of iconHrefs(html)) yield* iconHrefCandidates(htmlPath, href);
  }
}

async function readHtmlHead(rootDir: string, htmlPath: string, platform: NodeJS.Platform): Promise<string | null> {
  try {
    const { fullPath } = validateIconPath(rootDir, htmlPath, platform);
    const bytes = await readWorkspaceFileBytes(fullPath, HTML_READ_MAX_BYTES);
    return bytes.subarray(0, HTML_READ_MAX_BYTES).toString("utf8");
  } catch (error) {
    if (isUnusablePath(error)) return null;
    throw error;
  }
}

/** `href`s of `<link rel="icon">` and `<link rel="shortcut icon">` tags, in document order. */
function iconHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = linkAttributes(tag);
    const rel = attributes.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    const href = attributes.get("href")?.trim();
    if (rel.includes("icon") && href) hrefs.push(href);
  }
  return hrefs;
}

/** `rel` and `href` of one `<link>` tag, keyed lower-case, accepting double, single, or no quotes. */
function linkAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/\b(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * Workspace-relative paths an icon href may point at. Site-absolute hrefs are
 * served from `public/` by common bundlers, so that folder is tried before the root.
 */
function iconHrefCandidates(htmlPath: string, href: string): string[] {
  if (href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return [];
  const path = href.split(/[?#]/, 1)[0] ?? "";
  if (path === "" || path === "/") return [];
  if (path.startsWith("/")) return [`public${path}`, path.slice(1)];
  const resolved = NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(htmlPath), path));
  return resolved.startsWith("../") ? [] : [resolved];
}

async function probeIconFile(
  rootDir: string,
  candidate: string,
  platform: NodeJS.Platform,
  probes: { remaining: number },
): Promise<IconFile | null> {
  if (probes.remaining <= 0) return null;
  probes.remaining -= 1;
  try {
    return await readIconFile(rootDir, candidate, platform);
  } catch (error) {
    if (isUnusablePath(error)) return null;
    throw error;
  }
}

async function readIconFile(rootDir: string, requestedPath: string, platform: NodeJS.Platform): Promise<IconFile> {
  const validated = validateIconPath(rootDir, requestedPath, platform);
  const { size, mtimeMs } = await NodeFS.promises.stat(validated.fullPath);
  const violation = iconRuleViolation(requestedPath, size);
  if (violation) throw new ProjectIconError("invalid_icon_path", violation);
  const version = NodeCrypto.createHash("sha256").update(`${validated.path}\0${mtimeMs}\0${size}`).digest("hex").slice(0, 16);
  return { path: validated.path, version };
}

function validateIconPath(rootDir: string, requestedPath: string, platform: NodeJS.Platform): { path: string; fullPath: string } {
  try {
    return validateWorkspaceFilePath(rootDir, requestedPath, platform);
  } catch (error) {
    if (error instanceof WorkspaceFileNotFoundError) throw error;
    // The shared validator rejects with plain Errors; anything it refuses is outside the project for icon purposes.
    throw new ProjectIconError("invalid_icon_path", "Choose a file inside the project.");
  }
}

function isUnusablePath(error: unknown): boolean {
  return error instanceof ProjectIconError || error instanceof WorkspaceFileNotFoundError;
}
