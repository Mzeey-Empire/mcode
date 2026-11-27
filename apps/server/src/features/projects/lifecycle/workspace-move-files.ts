import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { noProjectIdFromFolderName } from "./no-project-folder-name.js";
import { isWithinWorkspaceRoot, resolveNoProjectRoot } from "./workspace-path.js";

const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** Format the filesystem or Git failure for the operation receipt. */
export function moveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Validate the managed source and resolve a new project name and parent on this machine. */
export async function resolveWorkspaceMovePaths(input: {
  workspaceId: string; storedSource: string; root: string; parentPath: string; name: string;
}): Promise<{ sourcePath: string; destinationPath: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.name) || input.name.endsWith(".") || RESERVED_NAME.test(input.name)) {
    throw new Error("Invalid project name");
  }
  const root = await resolveNoProjectRoot(input.root);
  const sourcePath = await managedSource(input, root);
  const requested = expandHome(input.parentPath);
  if (!NodePath.isAbsolute(requested)) throw new Error("Project location must be an absolute folder");
  const parent = await NodeFSPromises.realpath(requested);
  if (!(await NodeFSPromises.stat(parent)).isDirectory()) throw new Error("Project location must be a folder");
  const destinationPath = NodePath.join(parent, input.name);
  if (isWithinWorkspaceRoot(root, destinationPath)) throw new Error("Project destination is inside the No project root");
  if (await lstatIfPresent(destinationPath)) throw new Error("Project destination already exists");
  return { sourcePath, destinationPath };
}

async function managedSource(input: { workspaceId: string; storedSource: string }, root: string): Promise<string> {
  const name = NodePath.basename(input.storedSource);
  const expected = NodePath.join(root, name);
  if (!NodePath.isAbsolute(input.storedSource)
    || noProjectIdFromFolderName(name) !== input.workspaceId
    || NodePath.relative(root, await NodeFSPromises.realpath(NodePath.dirname(input.storedSource))) !== ""
    || NodePath.relative(expected, await NodeFSPromises.realpath(input.storedSource)) !== ""
    || !(await NodeFSPromises.lstat(input.storedSource)).isDirectory()) {
    throw new Error("No project folder does not match its managed location");
  }
  return expected;
}

function expandHome(path: string): string {
  if (path === "~") return NodeOS.homedir();
  if (path.startsWith("~/") || (NodePath.sep === "\\" && path.startsWith("~\\"))) {
    return NodePath.join(NodeOS.homedir(), path.slice(2));
  }
  return path;
}

async function lstatIfPresent(path: string) {
  try {
    return await NodeFSPromises.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Names the exclusive ownership marker in a move's recorded folder. */
export function markerPath(folder: string, moveId: string): string {
  return NodePath.join(folder, `.mcode-move-${moveId}`);
}

/** Filesystem observations used by the rollback table. */
export type MoveFolderState = "missing" | "empty" | "marker-only" | "owned" | "foreign" | "other";

/** Reject recorded paths whose parents have been redirected since the move was prepared. */
export async function assertRecordedParent(folder: string): Promise<void> {
  const parent = NodePath.dirname(folder);
  if (NodePath.relative(parent, await NodeFSPromises.realpath(parent)) !== "") {
    throw new Error(`Move folder parent was redirected: ${parent}`);
  }
}

async function lstatRecordedFolder(folder: string) {
  try {
    await assertRecordedParent(folder);
    return await lstatIfPresent(folder);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Read only enough directory entries to distinguish an owned folder from its empty claim. */
export async function inspectMoveFolder(folder: string, moveId: string): Promise<MoveFolderState> {
  const entry = await lstatRecordedFolder(folder);
  if (!entry) return "missing";
  if (!entry.isDirectory()) return "other";
  const owned = (await lstatIfPresent(markerPath(folder, moveId)))?.isFile() === true;
  const contents = await NodeFSPromises.opendir(folder);
  try {
    const first = await contents.read();
    if (!first) return "empty";
    const onlyMarker = owned && first.name === NodePath.basename(markerPath(folder, moveId)) && !await contents.read();
    if (onlyMarker) return "marker-only";
    return owned ? "owned" : "foreign";
  } finally {
    await contents.close();
  }
}

/** Remove only this move's marker from a directory that still exists at the recorded path. */
export async function removeMoveMarker(folder: string, moveId: string): Promise<void> {
  if (!(await lstatRecordedFolder(folder))?.isDirectory()) return;
  try {
    await NodeFSPromises.unlink(markerPath(folder, moveId));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Remove an empty claim, preserving files if something wrote into it. */
export async function removeMoveClaim(folder: string, moveId: string): Promise<void> {
  await removeMoveMarker(folder, moveId);
  try {
    await NodeFSPromises.rmdir(folder);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Write the ownership marker exclusively before renaming either directory. */
export async function writeMoveMarker(folder: string, moveId: string): Promise<void> {
  await assertRecordedParent(folder);
  if (!(await NodeFSPromises.lstat(folder)).isDirectory()) throw new Error(`Move folder is not a directory: ${folder}`);
  await NodeFSPromises.writeFile(markerPath(folder, moveId), "", { flag: "wx" });
}
