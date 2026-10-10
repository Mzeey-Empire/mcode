/**
 * File listing and reading service.
 * Provides git-tracked file listing (including untracked) and safe file reading.
 * Extracted from apps/desktop/src/main/file-ops.ts with untracked file support.
 */

import { injectable, inject, delay } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { FILE_LIST_MAX_PATHS, FILE_VIEW_TEXT_MAX_BYTES, FILE_CHANGES_MAX_ENTRIES, WORKSPACE_IMAGE_MAX_BYTES, type WorkspaceFileList, type WorkspaceFileChanges, type FileReadResult } from "@mcode/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GitWorktreeService } from "../git/git-worktree-service.js";
import type { GitExecutor } from "../git/execution/index.js";

const MAX_CHANGED_PATHS = 100;
const LIST_WALK_MAX_DEPTH = 8;
const LIST_WALK_MAX_ENTRIES = 5000;
const LIST_WALK_SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** Missing workspace file, preserved as a typed error by the RPC router. */
export class WorkspaceFileNotFoundError extends Error {
  readonly code = "not_found";

  constructor() {
    super("This file no longer exists.");
  }
}

/** Handles file listing and content reading for workspaces and threads. */
@injectable()
export class FileService {
  private readonly statusFingerprints = new Map<string, string>();

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(delay(() => GitWorktreeService)) private readonly gitWorktrees: GitWorktreeService,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {}

  /**
   * List files in a workspace, including both tracked and untracked files.
   * Uses `git ls-files --cached --others --exclude-standard -z` to include
   * untracked files that are not gitignored. The `-z` output is NUL-delimited
   * and unquoted, so non-ASCII and whitespace-bearing names arrive verbatim.
   */
  async list(workspaceId: string, threadId?: string): Promise<WorkspaceFileList> {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);

    try {
      const paths = new Set<string>();
      let truncated = false;
      await this.readGitRecords(
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd,
        (path) => {
          if (paths.has(path)) return;
          if (paths.size < FILE_LIST_MAX_PATHS) paths.add(path);
          else truncated = true;
        },
      );
      return { paths: [...paths], truncated };
    } catch (err) {
      // Non-git folders have no ls-files source; a real repo failure still throws.
      if (NodeFS.existsSync(NodePath.join(cwd, ".git"))) {
        throw new Error(
          `Failed to list files: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return listDirectoryTree(cwd);
    }
  }

  /** Returns bounded file marks relative to HEAD for the selected checkout. */
  async changes(workspaceId: string, threadId?: string): Promise<WorkspaceFileChanges> {
    const status = await this.readStatus(this.resolveWorkingDir(workspaceId, threadId));
    if (status === null) return { git: false, entries: [], truncated: false };
    const entries: WorkspaceFileChanges["entries"] = [];
    for (const { path, status: mark } of status) {
      if (mark.includes("D")) continue;
      entries.push({ path, mark: /[?AR]/.test(mark) ? "A" : "M" });
      if (entries.length > FILE_CHANGES_MAX_ENTRIES) break;
    }
    return { git: true, entries: entries.slice(0, FILE_CHANGES_MAX_ENTRIES), truncated: entries.length > FILE_CHANGES_MAX_ENTRIES };
  }

  private async readStatus(cwd: string): Promise<Array<{ path: string; status: string }> | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(["rev-parse", "--show-prefix"], { cwd });
      const prefix = stdout.replace(/\r?\n$/, "");
      const entries: Array<{ path: string; status: string }> = [];
      let skipSource = false;
      await this.readGitRecords(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], cwd,
        (record) => {
          if (skipSource) { skipSource = false; return; }
          if (record.length < 4) return;
          const status = record.slice(0, 2);
          entries.push({ path: record.slice(3 + prefix.length), status });
          skipSource = /[RC]/.test(status);
        },
      );
      return entries;
    } catch (error) {
      if (NodeFS.existsSync(NodePath.join(cwd, ".git"))) throw error;
      return null;
    }
  }

  private async readGitRecords(args: string[], cwd: string, onRecord: (record: string) => void): Promise<void> {
    let pending = "";
    await this.gitExecutor.exec(args, {
      cwd,
      retainStdout: false,
      onStdout(chunk) {
        const records = (pending + chunk).split("\0");
        pending = records.pop() ?? "";
        for (const record of records) if (record) onRecord(record);
      },
    });
    if (pending) onRecord(pending);
  }

  /**
   * Runs one bounded `git status` for the scope and reports paths whose
   * dirty-set fingerprint moved since the previous refresh. The first call
   * only records the baseline; callers emit `files.changed` on real deltas.
   * `--untracked-files=all` expands untracked directories to their files:
   * default status output collapses them to `?? dir/`, which hides file
   * additions and removals inside the directory from the fingerprint.
   * Non-git scopes fingerprint the bounded directory listing instead.
   * Returns null when the fingerprint is unchanged.
   */
  async refresh(
    workspaceId: string,
    threadId?: string,
  ): Promise<{ changedPaths: string[]; wholeWorkspace: boolean } | null> {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);
    const scope = `${workspaceId}:${threadId ?? ""}`;

    let paths: string[];
    try {
      const status = await this.readStatus(cwd);
      paths = status === null ? listDirectoryTree(cwd).paths : status.map((entry) => entry.path);
    } catch {
      // Non-git folders fingerprint the same bounded listing `list` falls back to.
      if (NodeFS.existsSync(NodePath.join(cwd, ".git"))) return null;
      paths = listDirectoryTree(cwd).paths;
    }

    // Paths may legally contain "\n" on POSIX filesystems, so fingerprints
    // join on the only separator git `-z` output can never embed in a name.
    const fingerprint = [...paths].sort().join("\0");
    const previous = this.statusFingerprints.get(scope);
    this.statusFingerprints.set(scope, fingerprint);
    if (previous === undefined || previous === fingerprint) return null;
    return diffFingerprints(previous, paths);
  }

  /**
   * Read file content by relative path within a workspace root.
   * Validates path stays within root to prevent traversal attacks.
   */
  async read(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
    as?: "text",
  ): Promise<FileReadResult> {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);
    const { path, fullPath } = validateWorkspaceFilePath(cwd, relativePath, this.hostRuntime.platform);
    const size = NodeFS.statSync(fullPath).size;
    const mime = workspaceImageMime(path);
    if (mime && as !== "text") {
      if (size > WORKSPACE_IMAGE_MAX_BYTES.file) return { kind: "too-large", path, size, limit: WORKSPACE_IMAGE_MAX_BYTES.file };
      const query = new URLSearchParams({ path, use: "file" });
      if (threadId) query.set("threadId", threadId);
      return { kind: "image", path, size, mime, url: `/workspace-images/${encodeURIComponent(workspaceId)}?${query}` };
    }
    const [bytes, changedLines] = await Promise.all([
      readWorkspaceFileBytes(fullPath, FILE_VIEW_TEXT_MAX_BYTES), this.readChangedLines(cwd, path),
    ]);
    const oversized = bytes.length > FILE_VIEW_TEXT_MAX_BYTES;
    const text = decodeText(bytes, oversized);
    if (text && oversized) return { kind: "too-large", path, size: Math.max(size, bytes.length), limit: FILE_VIEW_TEXT_MAX_BYTES };
    return text === null
      ? { kind: "binary", path, size: Math.max(size, bytes.length) }
      : { kind: "text", path, size: bytes.length, ...text, changedLines };
  }

  private async readChangedLines(cwd: string, path: string): Promise<Array<[number, number]> | null> {
    if (!await this.isGitWorkTree(cwd)) return null;
    let pending = "";
    let added = false;
    let hasDiff = false;
    const ranges: Array<[number, number]> = [];
    try {
      await this.gitExecutor.exec(
        ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "HEAD", "--", path],
        {
          cwd, env: { GIT_LITERAL_PATHSPECS: "1" }, retainStdout: false,
          onStdout(chunk) {
            if (chunk) hasDiff = true;
            const lines = (pending + chunk).split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("new file mode ")) added = true;
              const range = changedLineRange(line);
              if (range) ranges.push(range);
            }
          },
        },
      );
      // Empty diffs include untracked files; new-file diffs are staged additions.
      return !hasDiff || added ? null : ranges;
    } catch (error) {
      if (!await this.hasGitHead(cwd)) return null;
      throw error;
    }
  }

  private async isGitWorkTree(cwd: string): Promise<boolean> {
    try {
      // The executor caches this probe by -C, keeping subsequent opens to one Git process.
      await this.gitExecutor.exec(["-C", cwd, "rev-parse", "--show-toplevel"]);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 128) return false;
      throw error;
    }
  }

  private async hasGitHead(cwd: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1) return false;
      throw error;
    }
  }

  /**
   * Validate that a relative file mention resolves to an existing file inside
   * the workspace or thread working directory.
   */
  validateMentionPath(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): void {
    const rootDir = this.resolveWorkingDir(workspaceId, threadId);
    const { fullPath } = validateWorkspaceFilePath(rootDir, relativePath, this.hostRuntime.platform);
    assertFileSize(fullPath, relativePath);
  }

  /**
   * Resolve the working directory for a workspace, optionally scoped to a thread.
   * Validates that the thread exists and belongs to the given workspace to prevent
   * cross-workspace file access.
   */
  resolveWorkingDir(
    workspaceId: string,
    threadId?: string,
  ): string {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    let thread = null;
    if (threadId) {
      thread = this.threadRepo.findById(threadId);
      if (!thread) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      if (thread.workspace_id !== workspaceId) {
        throw new Error(
          `Thread ${threadId} does not belong to workspace ${workspaceId}`,
        );
      }
    }

    return this.gitWorktrees.resolveWorkingDir(
      workspace.path,
      thread?.mode ?? null,
      thread?.worktree_path ?? null,
    );
  }
}

/** Validates an existing file and returns its normalized relative and canonical paths. */
export function validateWorkspaceFilePath(
  rootDir: string,
  relativePath: string,
  platform?: NodeJS.Platform,
): { path: string; fullPath: string } {
  const segments = relativePath.split(/[\\/]/);
  if (NodePath.isAbsolute(relativePath) || /[:\0]/.test(relativePath) || segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error("Invalid file path");
  }
  const path = segments.join("/");
  const fullPath = NodePath.resolve(rootDir, path);
  try {
    return { path, fullPath: assertPathWithinRoot(rootDir, fullPath, platform) };
  } catch (error) {
    if (isMissingFile(error)) throw new WorkspaceFileNotFoundError();
    throw error;
  }
}

function assertPathWithinRoot(rootDir: string, fullPath: string, platform?: NodeJS.Platform): string {
  const canonicalRoot = normalizePathForComparison(NodeFS.realpathSync(rootDir), platform);
  const realPath = NodeFS.realpathSync(fullPath);
  const canonicalPath = normalizePathForComparison(realPath, platform);
  const relative = NodePath.relative(canonicalRoot, canonicalPath);
  if (relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)) {
    throw new Error("File path escapes workspace root");
  }
  if (!NodeFS.statSync(realPath).isFile()) throw new WorkspaceFileNotFoundError();
  return realPath;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
};

/** MIME allowlist shared by structured reads and the workspace image route. */
export function workspaceImageMime(path: string): string | undefined {
  return IMAGE_MIME_TYPES[NodePath.extname(path).toLowerCase()];
}

/** Reads at most limit + 1 bytes so callers can reject oversized or growing files. */
export async function readWorkspaceFileBytes(path: string, limit: number): Promise<Buffer> {
  try {
    const file = await NodeFS.promises.open(path, "r");
    try {
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isMissingFile(error)) throw new WorkspaceFileNotFoundError();
    throw error;
  }
}

function decodeText(bytes: Buffer, partial: boolean): Pick<Extract<FileReadResult, { kind: "text" }>, "content" | "encoding"> | null {
  const encoding = textEncoding(bytes);
  if (encoding === null) return null;
  try {
    return { encoding, content: new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: partial }) };
  } catch {
    return null;
  }
}

function changedLineRange(line: string): [number, number] | null {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  const start = Number(match[1]);
  const count = Number(match[2] ?? 1);
  return count > 0 ? [start, start + count - 1] : null;
}

function textEncoding(bytes: Buffer): "utf-8" | "utf-16le" | "utf-16be" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  return bytes.subarray(0, 8192).includes(0) ? null : "utf-8";
}

function normalizePathForComparison(path: string, platform?: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

function assertFileSize(fullPath: string, relativePath: string): void {
  const maxFileSize = 256 * 1024;
  const { size } = NodeFS.statSync(fullPath);
  if (size > maxFileSize) {
    throw new Error(
      `File too large for injection: ${relativePath} (${size} bytes, max ${maxFileSize})`,
    );
  }
}

/** Reports the symmetric difference between a stored fingerprint and the current path list. */
function diffFingerprints(
  previous: string,
  paths: string[],
): { changedPaths: string[]; wholeWorkspace: boolean } {
  const current = new Set(paths);
  const prior = new Set(previous.split("\0").filter((path) => path.length > 0));
  const delta = new Set<string>();
  for (const path of current) if (!prior.has(path)) delta.add(path);
  for (const path of prior) if (!current.has(path)) delta.add(path);
  const changedPaths = [...delta].slice(0, MAX_CHANGED_PATHS + 1);
  const wholeWorkspace = changedPaths.length > MAX_CHANGED_PATHS;
  return { changedPaths: wholeWorkspace ? [] : changedPaths, wholeWorkspace };
}

/**
 * Bounded recursive walk used only for non-git folders, where `git ls-files`
 * cannot provide an ignore-aware listing. Skips `.git` and `node_modules`
 * and stops at the depth/entry caps so huge trees stay cheap.
 */
function listDirectoryTree(root: string): WorkspaceFileList {
  const results: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > LIST_WALK_MAX_DEPTH) { truncated = true; return; }
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= LIST_WALK_MAX_ENTRIES) { truncated = true; return; }
      if (entry.isDirectory() && LIST_WALK_SKIPPED_DIRS.has(entry.name)) continue;
      const relative = NodePath.relative(root, NodePath.join(dir, entry.name)).replaceAll(NodePath.sep, "/");
      if (entry.isDirectory()) {
        walk(NodePath.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        results.push(relative);
      }
    }
  };
  walk(root, 0);
  return { paths: results, truncated };
}
