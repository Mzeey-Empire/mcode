/**
 * File listing and reading service.
 * Provides git-tracked file listing (including untracked) and safe file reading.
 * Extracted from apps/desktop/src/main/file-ops.ts with untracked file support.
 */

import { injectable, inject, delay } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
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
   * Uses `git ls-files --cached --others --exclude-standard` to include
   * untracked files that are not gitignored.
   */
  async list(workspaceId: string, threadId?: string): Promise<string[]> {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);

    try {
      const { stdout } = await this.gitExecutor.exec(
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd },
      );
      return stdout
        .split("\n")
        .filter((line: string) => line.length > 0);
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
      const { stdout } = await this.gitExecutor.exec(
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd },
      );
      paths = parsePorcelainPaths(stdout);
    } catch {
      // Non-git folders fingerprint the same bounded listing `list` falls back to.
      if (NodeFS.existsSync(NodePath.join(cwd, ".git"))) return null;
      paths = listDirectoryTree(cwd);
    }

    const fingerprint = [...paths].sort().join("\n");
    const previous = this.statusFingerprints.get(scope);
    this.statusFingerprints.set(scope, fingerprint);
    if (previous === undefined || previous === fingerprint) return null;
    return diffFingerprints(previous, paths);
  }

  /**
   * Read file content by relative path within a workspace root.
   * Validates path stays within root to prevent traversal attacks.
   */
  read(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): string {
    const canonicalPath = this.validateWorkspaceRelativePath(
      workspaceId,
      relativePath,
      threadId,
    );

    return NodeFS.readFileSync(canonicalPath, "utf-8");
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
    this.validateWorkspaceRelativePath(workspaceId, relativePath, threadId);
  }

  private validateWorkspaceRelativePath(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): string {
    assertRelativeFilePath(relativePath);
    const rootDir = this.resolveWorkingDir(workspaceId, threadId);
    const fullPath = NodePath.resolve(rootDir, relativePath);
    assertFileExists(fullPath, relativePath);
    const canonicalPath = assertPathWithinRoot(
      rootDir,
      fullPath,
      relativePath,
      this.hostRuntime.platform,
    );
    assertFileSize(fullPath, relativePath);
    return canonicalPath;
  }

  /**
   * Resolve the working directory for a workspace, optionally scoped to a thread.
   * Validates that the thread exists and belongs to the given workspace to prevent
   * cross-workspace file access.
   */
  /** Resolves the local root used for direct file operations in one workspace scope. */
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

function assertRelativeFilePath(relativePath: string): void {
  if (NodePath.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.includes("\0")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
}

function assertFileExists(fullPath: string, relativePath: string): void {
  if (!NodeFS.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }
}

function assertPathWithinRoot(
  rootDir: string,
  fullPath: string,
  relativePath: string,
  platform: NodeJS.Platform,
): string {
  const canonicalRoot = normalizePathForComparison(NodeFS.realpathSync(rootDir), platform);
  const canonicalPath = normalizePathForComparison(NodeFS.realpathSync(fullPath), platform);
  const rootWithSeparator = canonicalRoot.endsWith(NodePath.sep)
    ? canonicalRoot
    : canonicalRoot + NodePath.sep;

  if (!canonicalPath.startsWith(rootWithSeparator) && canonicalPath !== canonicalRoot) {
    throw new Error(`File path escapes workspace root: ${relativePath}`);
  }

  return canonicalPath;
}

function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
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

/** Extracts the path from a `git status --porcelain` v1 line (`XY path` or `XY old -> new`). */
function porcelainPath(line: string): string {
  const raw = line.slice(3);
  const renamed = raw.split(" -> ").at(-1) ?? raw;
  return renamed.replace(/^"|"$/g, "");
}

/** Reports the symmetric difference between a stored fingerprint and the current path list. */
function diffFingerprints(
  previous: string,
  paths: string[],
): { changedPaths: string[]; wholeWorkspace: boolean } {
  const current = new Set(paths);
  const prior = new Set(previous.split("\n").filter((path) => path.length > 0));
  const delta = new Set<string>();
  for (const path of current) if (!prior.has(path)) delta.add(path);
  for (const path of prior) if (!current.has(path)) delta.add(path);
  const changedPaths = [...delta].slice(0, MAX_CHANGED_PATHS + 1);
  const wholeWorkspace = changedPaths.length > MAX_CHANGED_PATHS;
  return { changedPaths: wholeWorkspace ? [] : changedPaths, wholeWorkspace };
}

function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map(porcelainPath);
}

/**
 * Bounded recursive walk used only for non-git folders, where `git ls-files`
 * cannot provide an ignore-aware listing. Skips `.git` and `node_modules`
 * and stops at the depth/entry caps so huge trees stay cheap.
 */
function listDirectoryTree(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > LIST_WALK_MAX_DEPTH || results.length >= LIST_WALK_MAX_ENTRIES) return;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= LIST_WALK_MAX_ENTRIES) return;
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
  return results;
}
