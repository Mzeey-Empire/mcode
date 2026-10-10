/**
 * Decorator-free workspace file access shared by FileService and the image route.
 * Kept out of file-service.ts so HTTP transport imports do not load tsyringe.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Missing workspace file, preserved as a typed error by the RPC router. */
export class WorkspaceFileNotFoundError extends Error {
  readonly code = "not_found";

  constructor() {
    super("This file no longer exists.");
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
      // Size from fstat so small files avoid a cap-sized allocation; the extra byte still catches growth mid-read.
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, limit) + 1);
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

function normalizePathForComparison(path: string, platform?: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}
