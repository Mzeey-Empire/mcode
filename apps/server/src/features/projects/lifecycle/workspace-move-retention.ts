import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { WorkspaceMove, WorkspaceMoveManifest, WorkspaceMoveStore } from "../persistence/workspace-move-store.js";
import { matchesMoveFile, recreateMoveLink } from "./workspace-move-copy.js";
import {
  assertRecordedParent, holdsMoveMarker, inspectMoveFolder, isMoveRenameBlocked, markerPath, moveEntry, moveError, moveErrorCode, renameWorkspaceFolder,
  type MoveFolderState, type WorkspaceMoveRenameOptions,
} from "./workspace-move-files.js";

type ManifestEntry = WorkspaceMoveManifest[number];
type CleanupCheckpoint = Parameters<WorkspaceMoveStore["sourceCleanup"]>[1];

export type WorkspaceMoveDeleteOptions = WorkspaceMoveRenameOptions & { unlink?: typeof NodeFSPromises.unlink };

type CleanupAction = "rename" | "check" | "remove-remnant" | "finish" | "keep";
type CleanupOutcome = { cleanup: "done" } | { cleanup: "kept" | "pending"; cleanupError: string };
type MoveCleanup = {
  move: WorkspaceMove;
  readManifest(): WorkspaceMoveManifest | null;
  checkpoint(next: CleanupCheckpoint): Promise<void>;
  options: WorkspaceMoveDeleteOptions;
};

const missingTombstone: Record<MoveFolderState, CleanupAction> = {
  missing: "finish", empty: "keep", "marker-only": "rename", owned: "rename", foreign: "keep", other: "keep",
};
const emptyTombstone: Record<MoveFolderState, CleanupAction> = {
  missing: "remove-remnant", empty: "remove-remnant", "marker-only": "keep",
  owned: "keep", foreign: "remove-remnant", other: "remove-remnant",
};
const cleanupActions: Record<MoveFolderState, CleanupAction | Record<MoveFolderState, CleanupAction>> = {
  missing: missingTombstone, empty: emptyTombstone, "marker-only": "remove-remnant", owned: "check", foreign: "keep", other: "keep",
};

class KeepFolder extends Error {}

/** Move an expired source off its old path and delete only entries proven to be in the copy. */
export function cleanRetainedMoveSource(input: MoveCleanup): Promise<CleanupOutcome> {
  return withCleanupOutcome(async () => {
    const tombstone = await prepareTombstone(input);
    if (tombstone) await deleteCheckedEntries(input, tombstone, "source");
  });
}

/** Roll back a published copy using its recorded copy identities and byte evidence. */
export function cleanPublishedMoveCopy(input: MoveCleanup): Promise<CleanupOutcome> {
  return withCleanupOutcome(() => deleteCheckedEntries(input, input.move.destinationPath, "copy"));
}

async function withCleanupOutcome(clean: () => Promise<void>): Promise<CleanupOutcome> {
  try {
    await clean();
    return { cleanup: "done" };
  } catch (error) {
    if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
    return { cleanup: error instanceof KeepFolder ? "kept" : "pending", cleanupError: moveError(error) };
  }
}

async function prepareTombstone({ move, checkpoint, options }: MoveCleanup): Promise<string | null> {
  const tombstone = NodePath.join(NodePath.dirname(move.sourcePath), `.mcode-trash-${move.id}`);
  const action = await observeCleanup(move, tombstone, checkpoint);
  switch (action) {
    case "finish":
      return null;
    case "keep":
      throw new KeepFolder("Source or tombstone no longer has the expected move marker");
    case "remove-remnant":
      await removeEmptyMoveFolder(tombstone, move.id, options);
      return null;
    case "rename":
      return renameSource(move, tombstone, checkpoint, options);
    case "check":
      return tombstone;
  }
}

async function observeCleanup(
  move: WorkspaceMove, tombstone: string, checkpoint: MoveCleanup["checkpoint"],
): Promise<CleanupAction> {
  if (move.tombstonePath && move.tombstonePath !== tombstone) throw new KeepFolder("Recorded tombstone path does not match the workspace move");
  const state = await inspectMoveFolder(tombstone, move.id);
  if (!move.tombstonePath && state !== "missing") {
    await checkpoint({ tombstonePath: tombstone });
    throw new KeepFolder("The tombstone path was occupied before cleanup");
  }
  const rule = cleanupActions[state];
  return typeof rule === "string" ? rule : rule[await inspectMoveFolder(move.sourcePath, move.id)];
}

async function renameSource(
  move: WorkspaceMove, tombstone: string, checkpoint: MoveCleanup["checkpoint"], options: WorkspaceMoveDeleteOptions,
): Promise<string | null> {
  if (!move.tombstonePath) await checkpoint({ tombstonePath: tombstone });
  if (!holdsMoveMarker(await inspectMoveFolder(move.sourcePath, move.id))) {
    throw new KeepFolder("The source lost its move marker before cleanup");
  }
  if (await moveEntry(tombstone)) throw new KeepFolder("The tombstone path was occupied before rename");
  await renameWorkspaceFolder(move.sourcePath, tombstone, options);
  const state = await inspectMoveFolder(tombstone, move.id);
  if (state === "owned") return tombstone;
  if (state !== "marker-only") throw new KeepFolder("The renamed source lost its move marker");
  await removeEmptyMoveFolder(tombstone, move.id, options);
  return null;
}

async function deleteCheckedEntries(
  { move, readManifest, checkpoint, options }: MoveCleanup, root: string, side: "source" | "copy",
): Promise<void> {
  const recorded = readManifest();
  if (!recorded) throw new KeepFolder("The move manifest is missing or invalid");
  const manifest = side === "source" ? recorded : recorded.map((entry) =>
    entry.kind === "folder" ? entry : { ...entry, inode: entry.copyInode });
  const staging = NodePath.join(root, ".mcode-delete");
  if (move.deleteStagingStarted) {
    await finishStagedEntries(root, staging, manifest, options);
  } else if (await moveEntry(staging)) {
    throw new KeepFolder("The delete staging folder is not owned by the move");
  }
  const present = await checkMoveFolder(root, move.id, manifest);
  if (side === "copy" && !move.deleteStagingStarted && present.size !== manifest.length) {
    throw new KeepFolder("The published copy is missing manifest entries");
  }
  if (!move.deleteStagingStarted) await beginDeleteStaging(staging, checkpoint);
  await stageAndDeleteEntries(root, staging, manifest, present, options);
  const folders = manifest.filter((entry) => entry.kind === "folder" && present.has(entry.path));
  folders.sort((left, right) => right.path.length - left.path.length);
  for (const { path } of folders) await removeEmptyDirectory(NodePath.join(root, path));
  await removeEmptyDirectory(staging);
  await removeEmptyMoveFolder(root, move.id, options);
}

async function beginDeleteStaging(staging: string, checkpoint: MoveCleanup["checkpoint"]): Promise<void> {
  await checkpoint({ deleteStagingStarted: true });
  try {
    await NodeFSPromises.mkdir(staging);
  } catch (error) {
    if (moveErrorCode(error) === "EEXIST") throw new KeepFolder("The delete staging folder was already occupied");
    throw error;
  }
}

async function stageAndDeleteEntries(
  root: string, staging: string, manifest: WorkspaceMoveManifest, present: Set<string>, options: WorkspaceMoveDeleteOptions,
): Promise<void> {
  for (const [index, entry] of manifest.entries()) {
    if (entry.kind === "folder" || !present.has(entry.path)) continue;
    const path = NodePath.join(root, entry.path);
    const slot = NodePath.join(staging, String(index));
    await assertRecordedParent(slot);
    if (await moveEntry(slot)) throw new KeepFolder(`Delete staging slot is occupied: ${slot}`);
    try {
      await assertRecordedParent(path);
      await renameWorkspaceFolder(path, slot, options);
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown || isMoveRenameBlocked(error)) throw error;
      throw new KeepFolder(`Could not stage ${entry.path}: ${moveError(error)}`);
    }
    await deleteStagedEntry(slot, path, entry, options);
  }
}

async function checkMoveFolder(root: string, moveId: string, manifest: WorkspaceMoveManifest): Promise<Set<string>> {
  const expected = new Map(manifest.map((entry) => [entry.path, entry]));
  const present = new Set<string>();
  const marker = NodePath.basename(markerPath(root, moveId));
  async function visit(relative: string) {
    const folder = NodePath.join(root, relative);
    await assertRecordedParent(folder);
    if (!(await moveEntry(folder))?.isDirectory()) throw new KeepFolder(`Folder changed: ${folder}`);
    const names = await NodeFSPromises.readdir(folder);
    const children = relative ? names : names.filter((name) => name !== marker && name !== ".mcode-delete");
    for (const name of children) {
      const path = NodePath.join(relative, name);
      const absolute = NodePath.join(root, path);
      const stat = await moveEntry(absolute);
      if (!stat) continue;
      const entry = expected.get(path);
      if (!entry || !await matchesEntry(absolute, stat, entry)) {
        throw new KeepFolder(`Folder changed since the copy: ${path}`);
      }
      present.add(path);
      if (entry.kind === "folder") await visit(path);
    }
  }
  await visit("");
  return present;
}

async function matchesEntry(path: string, stat: NonNullable<Awaited<ReturnType<typeof moveEntry>>>, entry: ManifestEntry): Promise<boolean> {
  if (entry.kind !== "folder" && String(stat.ino) !== entry.inode) return false;
  switch (entry.kind) {
    case "folder":
      return stat.isDirectory();
    case "link":
      return stat.isSymbolicLink() && await NodeFSPromises.readlink(path) === entry.target;
    case "file":
      return matchesMoveFile(path, stat, entry.size, entry.hash);
  }
}

async function finishStagedEntries(
  root: string, staging: string, manifest: WorkspaceMoveManifest, options: WorkspaceMoveDeleteOptions,
): Promise<void> {
  if (!(await moveEntry(staging))) await NodeFSPromises.mkdir(staging);
  if (!(await moveEntry(staging))?.isDirectory()) throw new KeepFolder("Delete staging folder was redirected");
  for (const name of await NodeFSPromises.readdir(staging)) {
    const index = Number(name);
    const entry = manifest[index];
    if (!entry || entry.kind === "folder" || String(index) !== name) throw new KeepFolder(`Unexpected delete staging slot: ${name}`);
    await deleteStagedEntry(NodePath.join(staging, name), NodePath.join(root, entry.path), entry, options);
  }
}

async function deleteStagedEntry(
  slot: string, original: string, entry: Exclude<ManifestEntry, { kind: "folder" }>, options: WorkspaceMoveDeleteOptions,
): Promise<void> {
  await assertRecordedParent(slot);
  const stat = await moveEntry(slot);
  const unlink = options.unlink ?? NodeFSPromises.unlink;
  if (stat && await matchesEntry(slot, stat, entry)) {
    await unlink(slot);
    return;
  }
  if (stat) {
    try {
      await assertRecordedParent(original);
      if (stat.isSymbolicLink()) {
        const target = await NodeFSPromises.readlink(slot);
        await recreateMoveLink(target, original, NodePath.dirname(original), options.platform);
      } else if (stat.isFile()) {
        await NodeFSPromises.link(slot, original);
      } else {
        throw new Error("Staged entry is neither a file nor a link");
      }
      await unlink(slot);
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      throw new KeepFolder(`Staged entry changed and could not be restored: ${original}: ${moveError(error)}`);
    }
  }
  throw new KeepFolder(`Staged entry changed since the copy: ${entry.path}`);
}

async function removeEmptyMoveFolder(root: string, moveId: string, options: WorkspaceMoveDeleteOptions): Promise<void> {
  await assertRecordedParent(root);
  const state = await inspectMoveFolder(root, moveId);
  if (state !== "marker-only" && state !== "empty" && state !== "missing") {
    throw new KeepFolder(`Folder contains new entries: ${root}`);
  }
  if (state === "marker-only") {
    const unlink = options.unlink ?? NodeFSPromises.unlink;
    await unlink(markerPath(root, moveId));
  }
  await removeEmptyDirectory(root);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await assertRecordedParent(path);
    const entry = await moveEntry(path);
    if (!entry) return;
    if (!entry.isDirectory()) throw new KeepFolder(`Folder was replaced: ${path}`);
    await NodeFSPromises.rmdir(path);
  } catch (error) {
    const code = moveErrorCode(error);
    if (code === "ENOENT") return;
    if (code === "ENOTEMPTY" || code === "EEXIST") throw new KeepFolder(`Folder contains new entries: ${path}`);
    throw error;
  }
}
