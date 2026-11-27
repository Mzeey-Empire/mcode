import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { WorkspaceMove, WorkspaceMoveManifest, WorkspaceMoveStore } from "../persistence/workspace-move-store.js";
import { matchesMoveFile, recreateMoveLink } from "./workspace-move-copy.js";
import {
  assertRecordedParent, holdsMoveMarker, inspectMoveFolder, markerPath, moveEntry, moveError, moveErrorCode, renameWorkspaceFolder,
  type MoveFolderState, type WorkspaceMoveRenameOptions,
} from "./workspace-move-files.js";

type ManifestEntry = WorkspaceMoveManifest[number];
type CleanupCheckpoint = Parameters<WorkspaceMoveStore["sourceCleanup"]>[1];

export type WorkspaceMoveDeleteOptions = WorkspaceMoveRenameOptions & { unlink?: typeof NodeFSPromises.unlink };

type CleanupAction = "rename" | "check" | "remove-remnant" | "finish" | "keep";
type CleanupOutcome = { cleanup: "done" } | { cleanup: "kept" | "pending"; cleanupError: string };
type RetainedSourceCleanup = {
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

class KeepSource extends Error {}

/** Move an expired source off its old path and delete only entries proven to be in the copy. */
export async function cleanRetainedMoveSource(input: RetainedSourceCleanup): Promise<CleanupOutcome> {
  try {
    const tombstone = await prepareTombstone(input);
    if (!tombstone) return { cleanup: "done" };
    const manifest = input.readManifest();
    if (!manifest) throw new KeepSource("The source manifest is missing or invalid");
    await deleteCheckedEntries({ ...input, tombstone, manifest });
    return { cleanup: "done" };
  } catch (error) {
    if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
    return { cleanup: error instanceof KeepSource ? "kept" : "pending", cleanupError: moveError(error) };
  }
}

async function prepareTombstone({ move, checkpoint, options }: RetainedSourceCleanup): Promise<string | null> {
  const tombstone = NodePath.join(NodePath.dirname(move.sourcePath), `.mcode-trash-${move.id}`);
  const action = await observeCleanup(move, tombstone, checkpoint);
  switch (action) {
    case "finish":
      return null;
    case "keep":
      throw new KeepSource("Source or tombstone no longer has the expected move marker");
    case "remove-remnant":
      await removeTombstone(tombstone, move.id, options);
      return null;
    case "rename":
      return renameSource(move, tombstone, checkpoint, options);
    case "check":
      return tombstone;
  }
}

async function observeCleanup(
  move: WorkspaceMove, tombstone: string, checkpoint: RetainedSourceCleanup["checkpoint"],
): Promise<CleanupAction> {
  if (move.tombstonePath && move.tombstonePath !== tombstone) throw new KeepSource("Recorded tombstone path does not match the workspace move");
  const state = await inspectMoveFolder(tombstone, move.id);
  if (!move.tombstonePath && state !== "missing") {
    await checkpoint({ tombstonePath: tombstone });
    throw new KeepSource("The tombstone path was occupied before cleanup");
  }
  const rule = cleanupActions[state];
  return typeof rule === "string" ? rule : rule[await inspectMoveFolder(move.sourcePath, move.id)];
}

async function renameSource(
  move: WorkspaceMove, tombstone: string, checkpoint: RetainedSourceCleanup["checkpoint"], options: WorkspaceMoveDeleteOptions,
): Promise<string | null> {
  if (!move.tombstonePath) await checkpoint({ tombstonePath: tombstone });
  if (!holdsMoveMarker(await inspectMoveFolder(move.sourcePath, move.id))) {
    throw new KeepSource("The source lost its move marker before cleanup");
  }
  if (await moveEntry(tombstone)) throw new KeepSource("The tombstone path was occupied before rename");
  await renameWorkspaceFolder(move.sourcePath, tombstone, options);
  const state = await inspectMoveFolder(tombstone, move.id);
  if (state === "owned") return tombstone;
  if (state !== "marker-only") throw new KeepSource("The renamed source lost its move marker");
  await removeTombstone(tombstone, move.id, options);
  return null;
}

async function deleteCheckedEntries(input: {
  tombstone: string;
  move: WorkspaceMove;
  manifest: WorkspaceMoveManifest;
  checkpoint(next: CleanupCheckpoint): Promise<void>;
  options: WorkspaceMoveDeleteOptions;
}): Promise<void> {
  const { tombstone, move, manifest, checkpoint, options } = input;
  const staging = NodePath.join(tombstone, ".mcode-delete");
  const entry = await moveEntry(staging);
  if (entry && (!move.deleteStagingStarted || !entry.isDirectory())) throw new KeepSource("The delete staging folder is not owned by the move");
  if (move.deleteStagingStarted) {
    if (!entry) await NodeFSPromises.mkdir(staging);
    await finishStagedEntries(tombstone, staging, manifest, options);
  }
  const present = await checkSource(tombstone, move.id, manifest);
  if (!move.deleteStagingStarted) await beginDeleteStaging(staging, checkpoint);
  await stageAndDeleteEntries(tombstone, staging, manifest, present, options);
  const folders = manifest.filter((entry) => entry.kind === "folder" && present.has(entry.path));
  folders.sort((left, right) => right.path.length - left.path.length);
  for (const { path } of folders) await removeEmptyDirectory(NodePath.join(tombstone, path));
  await removeEmptyDirectory(staging);
  await removeTombstone(tombstone, move.id, options);
}

async function beginDeleteStaging(staging: string, checkpoint: RetainedSourceCleanup["checkpoint"]): Promise<void> {
  await checkpoint({ deleteStagingStarted: true });
  try {
    await NodeFSPromises.mkdir(staging);
  } catch (error) {
    if (moveErrorCode(error) === "EEXIST") throw new KeepSource("The delete staging folder was already occupied");
    throw error;
  }
}

async function stageAndDeleteEntries(
  tombstone: string, staging: string, manifest: WorkspaceMoveManifest, present: Set<string>, options: WorkspaceMoveDeleteOptions,
): Promise<void> {
  for (const [index, entry] of manifest.entries()) {
    if (entry.kind === "folder" || !present.has(entry.path)) continue;
    const path = NodePath.join(tombstone, entry.path);
    const slot = NodePath.join(staging, String(index));
    await assertRecordedParent(slot);
    if (await moveEntry(slot)) throw new KeepSource(`Delete staging slot is occupied: ${slot}`);
    try {
      await assertRecordedParent(path);
      await renameWorkspaceFolder(path, slot, options);
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      throw new KeepSource(`Could not stage ${entry.path}: ${moveError(error)}`);
    }
    await deleteStagedEntry(slot, path, entry, options);
  }
}

async function checkSource(root: string, moveId: string, manifest: WorkspaceMoveManifest): Promise<Set<string>> {
  const expected = new Map(manifest.map((entry) => [entry.path, entry]));
  const present = new Set<string>();
  const marker = NodePath.basename(markerPath(root, moveId));
  async function visit(relative: string) {
    const folder = NodePath.join(root, relative);
    await assertRecordedParent(folder);
    if (!(await moveEntry(folder))?.isDirectory()) throw new KeepSource(`Source folder changed: ${folder}`);
    const names = await NodeFSPromises.readdir(folder);
    const children = relative ? names : names.filter((name) => name !== marker && name !== ".mcode-delete");
    for (const name of children) {
      const path = NodePath.join(relative, name);
      const absolute = NodePath.join(root, path);
      const stat = await moveEntry(absolute);
      if (!stat) continue;
      const entry = expected.get(path);
      if (!entry || !await matchesEntry(absolute, stat, entry)) throw new KeepSource(`Source changed since the copy: ${path}`);
      present.add(path);
      if (entry.kind === "folder") await visit(path);
    }
  }
  await visit("");
  return present;
}

async function matchesEntry(path: string, stat: NonNullable<Awaited<ReturnType<typeof moveEntry>>>, entry: ManifestEntry): Promise<boolean> {
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
  if (!(await moveEntry(staging))?.isDirectory()) throw new KeepSource("Delete staging folder was redirected");
  for (const name of await NodeFSPromises.readdir(staging)) {
    const index = Number(name);
    const entry = manifest[index];
    if (!entry || entry.kind === "folder" || String(index) !== name) throw new KeepSource(`Unexpected delete staging slot: ${name}`);
    await deleteStagedEntry(NodePath.join(staging, name), NodePath.join(root, entry.path), entry, options);
  }
}

async function deleteStagedEntry(
  slot: string, original: string, entry: Exclude<ManifestEntry, { kind: "folder" }>, options: WorkspaceMoveDeleteOptions,
): Promise<void> {
  await assertRecordedParent(slot);
  const stat = await moveEntry(slot);
  const unlink = options.unlink ?? NodeFSPromises.unlink;
  if (stat && String(stat.ino) === entry.inode && await matchesEntry(slot, stat, entry)) {
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
      throw new KeepSource(`Staged entry changed and could not be restored: ${original}: ${moveError(error)}`);
    }
  }
  throw new KeepSource(`Staged entry changed since the copy: ${entry.path}`);
}

async function removeTombstone(tombstone: string, moveId: string, options: WorkspaceMoveDeleteOptions): Promise<void> {
  await assertRecordedParent(tombstone);
  const state = await inspectMoveFolder(tombstone, moveId);
  if (state !== "marker-only" && state !== "empty" && state !== "missing") {
    throw new KeepSource(`Tombstone contains new entries: ${tombstone}`);
  }
  if (state === "marker-only") {
    const unlink = options.unlink ?? NodeFSPromises.unlink;
    await unlink(markerPath(tombstone, moveId));
  }
  await removeEmptyDirectory(tombstone);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await assertRecordedParent(path);
    const entry = await moveEntry(path);
    if (!entry) return;
    if (!entry.isDirectory()) throw new KeepSource(`Folder was replaced: ${path}`);
    await NodeFSPromises.rmdir(path);
  } catch (error) {
    const code = moveErrorCode(error);
    if (code === "ENOENT") return;
    if (code === "ENOTEMPTY" || code === "EEXIST") throw new KeepSource(`Folder contains new entries: ${path}`);
    throw error;
  }
}
