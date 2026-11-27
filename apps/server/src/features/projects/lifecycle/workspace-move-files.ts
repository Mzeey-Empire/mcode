import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import type { WorkspaceMoveFailureCause } from "@mcode/contracts/ws/workspace-move";
import { noProjectIdFromFolderName } from "./no-project-folder-name.js";
import { isWithinWorkspaceRoot, resolveNoProjectRoot } from "./workspace-path.js";

const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const WINDOWS_RENAME_RETRY_CODES = new Set<unknown>(["EBUSY", "EPERM", "EACCES"]);

class WindowsRenameInUse extends Error {}

export type WorkspaceMoveRenameOptions = {
  platform: NodeJS.Platform;
  rename?: typeof NodeFSPromises.rename;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Give exiting processes and file scanners time to release Windows handles.
 * Stop after three seconds of waiting so a long-lived holder still fails the move.
 */
export async function renameWorkspaceFolder(
  source: string,
  destination: string,
  { platform, rename = NodeFSPromises.rename, sleep = NodeTimersPromises.setTimeout }: WorkspaceMoveRenameOptions,
): Promise<void> {
  if (platform !== "win32") return rename(source, destination);
  for (const delay of [100, 200, 400, 800, 1500]) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!WINDOWS_RENAME_RETRY_CODES.has(moveErrorCode(error))) throw error;
    }
    await sleep(delay);
  }
  await rename(source, destination).catch((error: unknown) => {
    // Windows reports EPERM for open handles as well as some permission failures.
    const code = moveErrorCode(error);
    if (code === "EBUSY" || code === "EPERM") {
      throw new WindowsRenameInUse(moveError(error), { cause: error });
    }
    throw error;
  });
}

export function moveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function moveErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export async function moveFailureCause(error: unknown, destination: string, platform: NodeJS.Platform): Promise<WorkspaceMoveFailureCause> {
  if (error instanceof WindowsRenameInUse) return { kind: "in-use" };
  switch (moveErrorCode(error)) {
    case "ENOSPC":
      return { kind: "no-space", drive: await destinationDrive(destination, platform) };
    case "EACCES":
    case "EPERM":
      return { kind: "permission" };
    default:
      return { kind: "other" };
  }
}

async function destinationDrive(destination: string, platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    const root = NodePath.win32.parse(destination).root.replace(/[\\/]$/, "");
    if (root) return root;
  }
  let mount = NodePath.dirname(destination);
  try {
    const { dev } = await NodeFSPromises.stat(mount);
    while (NodePath.dirname(mount) !== mount) {
      const parent = NodePath.dirname(mount);
      if ((await NodeFSPromises.stat(parent)).dev !== dev) break;
      mount = parent;
    }
  } catch {
    // An inaccessible parent must not hide the original ENOSPC error.
  }
  return mount;
}

function isMissing(error: unknown): boolean {
  return moveErrorCode(error) === "ENOENT";
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
  if (await moveEntry(destinationPath)) throw new Error("Project destination already exists");
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

/** Read the entry itself, preserving its exact inode and handling only an absent path. */
export async function moveEntry(path: string) {
  try {
    return await NodeFSPromises.lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function markerPath(folder: string, moveId: string): string {
  return NodePath.join(folder, `.mcode-move-${moveId}`);
}

export type MoveFolderState = "missing" | "empty" | "marker-only" | "owned" | "foreign" | "other";

export function holdsMoveMarker(state: MoveFolderState): boolean {
  return state === "marker-only" || state === "owned";
}

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
    return await moveEntry(folder);
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
  const owned = (await moveEntry(markerPath(folder, moveId)))?.isFile() === true;
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

/** Remove an owned copy with the marker still available if removing its contents fails. */
export async function removeMoveCopy(folder: string, moveId: string): Promise<void> {
  if (!holdsMoveMarker(await inspectMoveFolder(folder, moveId))) throw new Error(`Copy does not hold its move marker: ${folder}`);
  const marker = NodePath.basename(markerPath(folder, moveId));
  for (const name of await NodeFSPromises.readdir(folder)) {
    if (name !== marker) await NodeFSPromises.rm(NodePath.join(folder, name), { recursive: true, force: true });
  }
  await removeMoveClaim(folder, moveId);
}

/** Write the ownership marker exclusively before renaming either directory. */
export async function writeMoveMarker(folder: string, moveId: string): Promise<void> {
  await assertRecordedParent(folder);
  if (!(await NodeFSPromises.lstat(folder)).isDirectory()) throw new Error(`Move folder is not a directory: ${folder}`);
  await NodeFSPromises.writeFile(markerPath(folder, moveId), "", { flag: "wx" });
}
