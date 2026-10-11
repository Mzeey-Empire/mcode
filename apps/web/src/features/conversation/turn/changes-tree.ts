import type { DiffStats, FileEffect, TurnSnapshot } from "@mcode/contracts";

/** How one changed file's line counts are known. */
export type FileCounts =
  | { readonly kind: "lines"; readonly additions: number; readonly deletions: number }
  | { readonly kind: "binary" }
  | { readonly kind: "uncounted" };

/** The net change a turn made to one file. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

/** One file a turn changed, as the end-of-turn changes bar lists it. */
export interface ChangedFile {
  /** Repo-relative path with forward slashes. */
  readonly path: string;
  readonly kind: ChangeKind;
  /** Repo-relative source path of a rename, when the source data carries it. */
  readonly oldPath?: string;
  readonly counts: FileCounts;
  /** A later turn in the same thread also changed this path. */
  readonly editedLater: boolean;
}

/** What the changes bar knows about a turn's files at a moment in time. */
export type TurnChanges =
  | { readonly status: "loading"; readonly paths: readonly string[] }
  | { readonly status: "ready"; readonly files: readonly ChangedFile[] }
  | { readonly status: "unavailable"; readonly paths: readonly string[] };

/** A folder in the changes tree. Single-child chains share one node and one label. */
export interface ChangesFolder {
  /** Unique within the tree: the folder's full path below the stripped common prefix. */
  readonly id: string;
  /** Display label, e.g. `components/chat` for a compressed chain. */
  readonly label: string;
  readonly files: readonly ChangedFile[];
  readonly folders: readonly ChangesFolder[];
  /** Files anywhere under this folder. */
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/** A turn's changed files grouped by folder below their longest common directory. */
export interface ChangesTree {
  readonly files: readonly ChangedFile[];
  readonly folders: readonly ChangesFolder[];
}

/** One rendered line of the changes list. */
export type ChangesRow =
  | { readonly kind: "folder"; readonly folder: ChangesFolder; readonly depth: number; readonly collapsed: boolean }
  | { readonly kind: "file"; readonly file: ChangedFile; readonly depth: number };

/** What the list footer says about rows the initial view leaves out. */
export type ChangesFooter =
  | { readonly kind: "folders"; readonly count: number }
  | { readonly kind: "files"; readonly count: number };

/** The list's starting state, decided once from the tree. */
export interface InitialCollapse {
  readonly collapsedFolders: ReadonlySet<string>;
  /** Maximum rows to show, or null for no cap. */
  readonly rowLimit: number | null;
  readonly footer: ChangesFooter | null;
}

/** Above this many rows, the list opens in a compact form and points to Review. */
export const MAX_INITIAL_ROWS = 12;

/** Normalizes a path to forward slashes. */
export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

interface MutableFolder {
  readonly segment: string;
  readonly files: ChangedFile[];
  readonly folders: Map<string, MutableFolder>;
}

function directorySegments(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function commonDirectoryLength(files: readonly ChangedFile[]): number {
  const [first, ...rest] = files.map((file) => directorySegments(file.path));
  if (!first) return 0;
  let length = first.length;
  for (const segments of rest) {
    let shared = 0;
    while (shared < length && shared < segments.length && segments[shared] === first[shared]) shared += 1;
    length = shared;
  }
  return length;
}

function insertFile(root: MutableFolder, segments: readonly string[], file: ChangedFile): void {
  let node = root;
  for (const segment of segments) {
    let next = node.folders.get(segment);
    if (!next) {
      next = { segment, files: [], folders: new Map() };
      node.folders.set(segment, next);
    }
    node = next;
  }
  node.files.push(file);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function byName(a: ChangedFile, b: ChangedFile): number {
  return fileName(a.path).localeCompare(fileName(b.path));
}

function lineCounts(file: ChangedFile): { additions: number; deletions: number } {
  return file.counts.kind === "lines" ? file.counts : { additions: 0, deletions: 0 };
}

function finishFolder(node: MutableFolder, parentId: string): ChangesFolder {
  let label = node.segment;
  let current = node;
  while (current.files.length === 0 && current.folders.size === 1) {
    const [only] = current.folders.values();
    if (!only) break;
    label = `${label}/${only.segment}`;
    current = only;
  }
  const id = parentId ? `${parentId}/${label}` : label;
  const files = [...current.files].sort(byName);
  const folders = finishFolders(current, id);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const counts = lineCounts(file);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  for (const folder of folders) {
    additions += folder.additions;
    deletions += folder.deletions;
  }
  const fileCount = files.length + folders.reduce((sum, folder) => sum + folder.fileCount, 0);
  return { id, label, files, folders, fileCount, additions, deletions };
}

function finishFolders(node: MutableFolder, parentId: string): ChangesFolder[] {
  return [...node.folders.values()]
    .map((child) => finishFolder(child, parentId))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Groups changed files into a folder tree. The longest directory prefix every
 * file shares is dropped, folders holding only one subfolder merge into it,
 * and each level lists its files A-Z before its subfolders A-Z.
 */
export function buildChangesTree(files: readonly ChangedFile[]): ChangesTree {
  const prefixLength = commonDirectoryLength(files);
  const root: MutableFolder = { segment: "", files: [], folders: new Map() };
  for (const file of files) insertFile(root, directorySegments(file.path).slice(prefixLength), file);
  return { files: [...root.files].sort(byName), folders: finishFolders(root, "") };
}

function pushFolderRows(
  rows: ChangesRow[],
  folder: ChangesFolder,
  depth: number,
  collapsedFolders: ReadonlySet<string>,
): void {
  const collapsed = collapsedFolders.has(folder.id);
  rows.push({ kind: "folder", folder, depth, collapsed });
  if (collapsed) return;
  for (const file of folder.files) rows.push({ kind: "file", file, depth: depth + 1 });
  for (const child of folder.folders) pushFolderRows(rows, child, depth + 1, collapsedFolders);
}

/** Flattens the tree into the rows a reader sees, skipping collapsed folders' contents. */
export function visibleRows(tree: ChangesTree, collapsedFolders: ReadonlySet<string>): ChangesRow[] {
  const rows: ChangesRow[] = tree.files.map((file) => ({ kind: "file", file, depth: 0 }));
  for (const folder of tree.folders) pushFolderRows(rows, folder, 0, collapsedFolders);
  return rows;
}

/** Every folder id in the tree, nested ones included. */
export function allFolderIds(tree: ChangesTree): string[] {
  const ids: string[] = [];
  const visit = (folder: ChangesFolder) => {
    ids.push(folder.id);
    folder.folders.forEach(visit);
  };
  tree.folders.forEach(visit);
  return ids;
}

/**
 * Decides how a long list first opens. Past {@link MAX_INITIAL_ROWS} rows,
 * top-level folders start collapsed; a list of only root files shows its
 * first rows and counts the rest. Either way the footer points to Review.
 */
export function initialCollapse(tree: ChangesTree): InitialCollapse {
  const none: InitialCollapse = { collapsedFolders: new Set(), rowLimit: null, footer: null };
  if (visibleRows(tree, none.collapsedFolders).length <= MAX_INITIAL_ROWS) return none;
  if (tree.folders.length > 0) {
    return {
      collapsedFolders: new Set(tree.folders.map((folder) => folder.id)),
      rowLimit: null,
      footer: { kind: "folders", count: tree.folders.length },
    };
  }
  return {
    collapsedFolders: new Set(),
    rowLimit: MAX_INITIAL_ROWS,
    footer: { kind: "files", count: tree.files.length - MAX_INITIAL_ROWS },
  };
}

function attributedPaths(snapshot: TurnSnapshot): string[] {
  return snapshot.file_effects
    ? snapshot.file_effects.effects.map((effect) => effect.path)
    : snapshot.files_changed;
}

/** Paths that snapshots created after `snapshot` in the same thread attribute to their turns. */
export function pathsEditedLater(snapshot: TurnSnapshot, snapshots: readonly TurnSnapshot[]): Set<string> {
  const createdAt = Date.parse(snapshot.created_at);
  const paths = new Set<string>();
  for (const other of snapshots) {
    if (other.thread_id !== snapshot.thread_id || Date.parse(other.created_at) <= createdAt) continue;
    for (const path of attributedPaths(other)) paths.add(toForwardSlashes(path));
  }
  return paths;
}

const EFFECT_KINDS: Record<FileEffect["kind"], ChangeKind> = {
  added: "added",
  edited: "modified",
  removed: "deleted",
  renamed: "renamed",
};

function effectCounts(effect: FileEffect): FileCounts {
  if (effect.binary) return { kind: "binary" };
  if (effect.additions === null || effect.deletions === null) return { kind: "uncounted" };
  return { kind: "lines", additions: effect.additions, deletions: effect.deletions };
}

/** Changed files from a snapshot's recorded file effects. External paths are not part of the repo diff. */
export function filesFromEffects(effects: readonly FileEffect[], editedLater: ReadonlySet<string>): ChangedFile[] {
  return effects
    .filter((effect) => effect.scope === "workspace")
    .map((effect) => {
      const path = toForwardSlashes(effect.path);
      return {
        path,
        kind: EFFECT_KINDS[effect.kind],
        ...(effect.oldPath ? { oldPath: toForwardSlashes(effect.oldPath) } : {}),
        counts: effectCounts(effect),
        editedLater: editedLater.has(path),
      };
    });
}

const STAT_KINDS: Record<DiffStats["changeType"], ChangeKind> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  // A copy creates a file the turn did not have before.
  copied: "added",
};

/** Changed files from git diff stats over the turn's snapshot range. */
export function filesFromStats(stats: readonly DiffStats[], editedLater: ReadonlySet<string>): ChangedFile[] {
  return stats.map((stat) => {
    const path = toForwardSlashes(stat.filePath);
    return {
      path,
      kind: STAT_KINDS[stat.changeType],
      counts: { kind: "lines", additions: stat.additions, deletions: stat.deletions },
      editedLater: editedLater.has(path),
    };
  });
}

/** Every path the bar lists for a turn, in source order. */
export function turnChangePaths(changes: TurnChanges): string[] {
  return changes.status === "ready" ? changes.files.map((file) => file.path) : [...changes.paths];
}
