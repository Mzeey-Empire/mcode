import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type { WorkspaceMoveManifest } from "../persistence/workspace-move-store.js";
import { assertRecordedParent, markerPath, moveErrorCode } from "./workspace-move-files.js";

type Entry = { path: string; stat: NodeFS.BigIntStats };
const READ_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

/** Copy an owned staging tree and record its identities and the source bytes actually read. */
export async function copyWorkspaceFolder(input: {
  source: string;
  staging: string;
  moveId: string;
  platform: NodeJS.Platform;
  openDestination?: typeof NodeFSPromises.open;
  progress(copied: number, total: number): Promise<void>;
}): Promise<WorkspaceMoveManifest> {
  const { source, staging, moveId, platform, openDestination = NodeFSPromises.open, progress } = input;
  const sourceRoot = platform === "win32" ? null : await NodeFSPromises.lstat(source, { bigint: true });
  const marker = markerPath(source, moveId);
  await NodeFSPromises.copyFile(marker, markerPath(staging, moveId), NodeFS.constants.COPYFILE_EXCL);
  const entries = await scan(source, NodePath.basename(marker));
  const total = entries.reduce((sum, { stat }) => sum + (stat.isFile() ? Number(stat.size) : 0), 0);
  const manifest: WorkspaceMoveManifest = [];
  let copied = 0;
  await progress(copied, total);
  async function addBytes(bytes: number) {
    copied += bytes;
    await progress(copied, total);
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const { path, stat } of entries) {
    const from = NodePath.join(source, path);
    const to = NodePath.join(staging, path);
    await assertRecordedParent(from);
    if (stat.isDirectory()) {
      await NodeFSPromises.mkdir(to);
      manifest.push({ kind: "folder", path });
    } else if (stat.isSymbolicLink()) {
      const target = await NodeFSPromises.readlink(from);
      await recreateMoveLink(target, to, NodePath.dirname(from), platform, path);
      await NodeFSPromises.lutimes(to, seconds(stat.atimeNs), seconds(stat.mtimeNs));
      const copy = await NodeFSPromises.lstat(to, { bigint: true });
      manifest.push({ kind: "link", path, inode: String(stat.ino), copyInode: String(copy.ino), target });
    } else {
      const evidence = await copyFile({ from, to, stat, buffer, openDestination, addBytes });
      await preserveMetadata(to, stat);
      manifest.push({ kind: "file", path, inode: String(stat.ino), ...evidence });
    }
  }
  // Populating a folder changes its times; restore those only once all its children exist.
  for (const { path, stat } of entries.reverse()) {
    if (stat.isDirectory()) await preserveMetadata(NodePath.join(staging, path), stat);
  }
  if (sourceRoot) await preserveMetadata(staging, sourceRoot);
  return manifest;
}

async function scan(root: string, marker: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(relative: string) {
    const folder = NodePath.join(root, relative);
    await assertRecordedParent(folder);
    if (!(await NodeFSPromises.lstat(folder)).isDirectory()) throw new Error(`Copy source folder changed: ${folder}`);
    for (const name of await NodeFSPromises.readdir(folder)) {
      if (relative === "" && name === marker) continue;
      const path = NodePath.join(relative, name);
      const stat = await NodeFSPromises.lstat(NodePath.join(root, path), { bigint: true });
      if (!stat.isDirectory() && !stat.isSymbolicLink() && !stat.isFile()) throw new Error(`Cannot copy special file: ${path}`);
      entries.push({ path, stat });
      if (stat.isDirectory()) await visit(path);
    }
  }
  await visit("");
  return entries;
}

async function copyFile(input: {
  from: string;
  to: string;
  stat: NodeFS.BigIntStats;
  buffer: Buffer;
  openDestination: typeof NodeFSPromises.open;
  addBytes(bytes: number): Promise<void>;
}): Promise<{ size: number; hash: string; copyInode: string }> {
  const { from, to, stat, buffer, openDestination, addBytes } = input;
  const source = await NodeFSPromises.open(from, READ_FLAGS);
  try {
    const identity = await source.stat({ bigint: true });
    if (!isSameFile(identity, stat)) throw new Error(`Copy source file changed: ${from}`);
    const destination = await openDestination(to, "wx");
    try {
      const hash = NodeCrypto.createHash("sha256");
      let size = 0;
      // Bound work by the size scanned even if a process is still appending to the source.
      while (size < Number(stat.size)) {
        const length = Math.min(buffer.length, Number(stat.size) - size);
        const { bytesRead } = await source.read(buffer, 0, length, null);
        if (bytesRead === 0) break;
        await destination.writeFile(buffer.subarray(0, bytesRead));
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
        await addBytes(bytesRead);
      }
      const copy = await destination.stat({ bigint: true });
      return { size, hash: hash.digest("hex"), copyInode: String(copy.ino) };
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

function seconds(nanoseconds: bigint): number {
  return Number(nanoseconds) / 1e9;
}

async function preserveMetadata(path: string, stat: NodeFS.BigIntStats): Promise<void> {
  await NodeFSPromises.chmod(path, Number(stat.mode) & 0o7777);
  await NodeFSPromises.utimes(path, seconds(stat.atimeNs), seconds(stat.mtimeNs));
}

/** Create a link exclusively and keep its target text relative if it was relative. */
export async function recreateMoveLink(
  target: string, path: string, originalParent: string, platform: NodeJS.Platform, copyRelativePath?: string,
): Promise<void> {
  if (platform !== "win32") {
    await NodeFSPromises.symlink(target, path);
    return;
  }
  const resolved = NodePath.resolve(originalParent, target);
  const directory = await NodeFSPromises.stat(resolved).then((stat) => stat.isDirectory(), (error: unknown) => {
    const code = moveErrorCode(error);
    if (code === "ENOENT" && copyRelativePath !== undefined) {
      throw new Error(`${copyRelativePath} is a link to something that does not exist, so Mcode can't tell how to copy it. Fix or remove the link, then try again.`);
    }
    if (code === "ENOENT" || code === "ELOOP") return false;
    throw error;
  });
  try {
    await NodeFSPromises.symlink(target, path, directory ? "dir" : "file");
  } catch (error) {
    // An existing junction can be copied by users who lack the Windows symlink privilege.
    if (moveErrorCode(error) !== "EPERM" || !directory || !NodePath.isAbsolute(target)) throw error;
    await NodeFSPromises.symlink(target, path, "junction");
  }
}

function isSameFile(opened: NodeFS.BigIntStats, expected: NodeFS.BigIntStats): boolean {
  return opened.isFile() && opened.ino === expected.ino && opened.dev === expected.dev;
}

/** Compare an opened file with the evidence read during the copy. */
export async function matchesMoveFile(path: string, stat: NodeFS.BigIntStats, size: number, hash: string): Promise<boolean> {
  if (!stat.isFile() || stat.size !== BigInt(size)) return false;
  const source = await NodeFSPromises.open(path, READ_FLAGS);
  try {
    const opened = await source.stat({ bigint: true });
    if (!isSameFile(opened, stat) || opened.size !== stat.size) return false;
    return await fileHash(source, size) === hash && (await source.stat({ bigint: true })).size === stat.size;
  } finally {
    await source.close();
  }
}

async function fileHash(source: NodeFSPromises.FileHandle, size: number): Promise<string | null> {
  const digest = NodeCrypto.createHash("sha256");
  const stream = source.createReadStream({ autoClose: false, ...(size > 0 ? { end: size - 1 } : {}) });
  let read = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected file bytes when checking the copy");
    read += chunk.length;
    digest.update(chunk);
    if (read > size) return null;
  }
  return read === size ? digest.digest("hex") : null;
}
