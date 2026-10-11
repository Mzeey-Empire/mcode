import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { z } from "zod";
import { isLiteralRepoPath } from "../../git/literal-paths.js";

/** Raw filesystem evidence, independent of Git filters and line ending normalization. */
export const PathStateSchema = z.object({
  kind: z.enum(["absent", "file", "symlink", "directory"]), mode: z.number().int(), size: z.number().int().nonnegative(),
  sha256: z.string().nullable(), linkTarget: z.string().nullable(),
});
/** Raw bytes are Git blobs pinned before a journaled operation writes. */
export const RawPathStateSchema = PathStateSchema.extend({ rawBlob: z.string().nullable() });
/** Raw filesystem comparison value. */
export type PathState = z.infer<typeof PathStateSchema>;
/** Recoverable raw filesystem value. */
export type RawPathState = z.infer<typeof RawPathStateSchema>;
/** A journaled path to restore. */
export interface RawRestoreEntry { path: string; state: RawPathState }

/** Execute byte-oriented Git plumbing. The text-only GitExecutor cannot carry binary blobs. */
export function rawGit(cwd: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile("git", ["-C", cwd, ...args], { encoding: "buffer", timeout: 30_000,
      maxBuffer: 128 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
}

/** Reject traversal and Git metadata before constructing a worktree path. */
export function rawPath(cwd: string, relative: string): string {
  if (!isLiteralRepoPath(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || part.replace(/[ .]+$/, "").toLowerCase() === ".git")
    || relative.includes("\\") || relative.includes(":")) throw new Error("Invalid revert path");
  return NodePath.join(cwd, relative);
}

/** Compare only raw evidence, not a recoverable blob id or filtered Git content. */
export function samePathState(a: PathState, b: PathState): boolean {
  return a.kind === b.kind && a.mode === b.mode && a.size === b.size && a.sha256 === b.sha256 && a.linkTarget === b.linkTarget;
}

/** A missing path, also used for children below a regular file. */
export function absentState(): RawPathState {
  return { kind: "absent", mode: 0, size: 0, sha256: null, linkTarget: null, rawBlob: null };
}

/** Confirm the nearest existing parent resolves inside the checkout before reading or writing. */
export async function checkRawParent(cwd: string, target: string): Promise<void> {
  let parent = NodePath.dirname(target);
  for (;;) {
    try {
      const resolved = await NodeFSPromises.realpath(parent);
      const relative = NodePath.relative(await NodeFSPromises.realpath(cwd), resolved);
      if (relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)) throw new Error("Revert parent escapes worktree");
      return;
    } catch (error) {
      if (!missingPath(error)) throw error;
      const next = NodePath.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function readRaw(cwd: string, relative: string, fileMode: boolean): Promise<{ state: RawPathState; bytes: Buffer | null }> {
  const target = rawPath(cwd, relative);
  await checkRawParent(cwd, target);
  let stat;
  try { stat = await NodeFSPromises.lstat(target); } catch (error) { if (missingPath(error)) return { state: absentState(), bytes: null }; throw error; }
  if (stat.isDirectory()) return { state: { ...absentState(), kind: "directory" }, bytes: null };
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Unsupported revert file type");
  return readContentState(target, stat, fileMode);
}

async function readContentState(target: string, stat: Awaited<ReturnType<typeof NodeFSPromises.lstat>>, fileMode: boolean): Promise<{ state: RawPathState; bytes: Buffer }> {
  const linkTarget = stat.isSymbolicLink() ? await NodeFSPromises.readlink(target) : null;
  const bytes = linkTarget === null ? await NodeFSPromises.readFile(target) : Buffer.from(linkTarget);
  const mode = stat.isFile() && fileMode ? (Number(stat.mode) & 0o111 ? 0o755 : 0o644) : 0;
  return { bytes, state: { kind: linkTarget === null ? "file" : "symlink", mode, size: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"), linkTarget, rawBlob: null } };
}

/** Capture raw state, optionally persisting unfiltered blobs in the repository object store. */
export async function readRawStates(cwd: string, paths: readonly string[], fileMode: boolean, objectCwd?: string): Promise<Map<string, RawPathState>> {
  const states = new Map<string, RawPathState>();
  for (const relative of paths) {
    const { state, bytes } = await readRaw(cwd, relative, fileMode);
    if (bytes !== null && objectCwd) state.rawBlob = (await rawGit(objectCwd, ["hash-object", "-w", "--no-filters", "--stdin"], bytes)).toString().trim();
    states.set(relative, state);
  }
  return states;
}

async function removeTarget(cwd: string, relative: string): Promise<void> {
  const target = rawPath(cwd, relative);
  await checkRawParent(cwd, target);
  try {
    const stat = await NodeFSPromises.lstat(target);
    if (stat.isDirectory()) await NodeFSPromises.rmdir(target);
    else await NodeFSPromises.unlink(target);
  } catch (error) { if (!missingPath(error)) throw error; }
}

async function removeEmptyParents(cwd: string, entries: readonly RawRestoreEntry[]): Promise<void> {
  const needed = entries.filter((entry) => entry.state.kind !== "absent").map((entry) => entry.path);
  for (const entry of entries) {
    let parent = NodePath.posix.dirname(entry.path);
    while (parent !== "." && !needed.some((target) => target === parent || target.startsWith(`${parent}/`))) {
      await checkRawParent(cwd, rawPath(cwd, parent));
      try { await NodeFSPromises.rmdir(rawPath(cwd, parent)); }
      catch (error) {
        if (missingPath(error)) break;
        if (error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) break;
        throw error;
      }
      parent = NodePath.posix.dirname(parent);
    }
  }
}

/** The only revert writer. Never recursively removes a target or follows a symlinked parent outside cwd. */
export async function restoreRaw(cwd: string, operationId: string, entries: readonly RawRestoreEntry[], afterWrite?: () => Promise<void>): Promise<void> {
  if (!/^[a-zA-Z0-9-]+$/.test(operationId)) throw new Error("Invalid revert operation id");
  const ordered = [...entries].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const entry of ordered.filter((value) => value.state.kind === "absent")) {
    await removeTarget(cwd, entry.path);
    await afterWrite?.();
  }
  await removeEmptyParents(cwd, ordered);
  for (const entry of ordered.reverse().filter((value) => value.state.kind !== "absent")) {
    await writeRawEntry(cwd, operationId, entry);
    await afterWrite?.();
  }
}

async function writeRawEntry(cwd: string, operationId: string, entry: RawRestoreEntry): Promise<void> {
  const target = rawPath(cwd, entry.path);
  await checkRawParent(cwd, target);
  await NodeFSPromises.mkdir(NodePath.dirname(target), { recursive: true });
  await checkRawParent(cwd, target);
  const { state } = entry;
  if (state.kind === "directory") {
    const current = await lstatOrMissing(target);
    if (current && !current.isDirectory()) await removeTarget(cwd, entry.path);
    await NodeFSPromises.mkdir(target, { recursive: true });
    return;
  }
  await writeContentState(cwd, operationId, target, state);
}

async function lstatOrMissing(target: string) {
  try { return await NodeFSPromises.lstat(target); }
  catch (error) { if (!missingPath(error)) throw error; return null; }
}

async function writeContentState(cwd: string, operationId: string, target: string, state: RawPathState): Promise<void> {
  if (!state.rawBlob) throw new Error("Missing raw recovery blob");
  const bytes = await rawGit(cwd, ["cat-file", "blob", state.rawBlob]);
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== state.sha256) throw new Error("Raw recovery blob does not match journal");
  const temporary = NodePath.join(NodePath.dirname(target), `.mcode-revert-${operationId}-${NodePath.basename(target)}`);
  if (state.kind === "symlink") await NodeFSPromises.symlink(bytes.toString(), temporary);
  else await NodeFSPromises.writeFile(temporary, bytes, { flag: "wx", ...(state.mode ? { mode: state.mode } : {}) });
  await checkRawParent(cwd, target);
  const current = await lstatOrMissing(target);
  if (current?.isDirectory()) await NodeFSPromises.rmdir(target);
  await NodeFSPromises.rename(temporary, target);
  if (state.kind === "file" && state.mode) await NodeFSPromises.chmod(target, state.mode);
}

/** Remove only this operation's known sibling temporary files during recovery. */
export async function removeRawTemps(cwd: string, operationId: string, paths: readonly string[]): Promise<void> {
  for (const relative of paths) {
    const target = rawPath(cwd, relative);
    await checkRawParent(cwd, target);
    const temporary = NodePath.join(NodePath.dirname(target), `.mcode-revert-${operationId}-${NodePath.basename(target)}`);
    await NodeFSPromises.unlink(temporary).catch((error: unknown) => { if (!missingPath(error)) throw error; });
  }
}
