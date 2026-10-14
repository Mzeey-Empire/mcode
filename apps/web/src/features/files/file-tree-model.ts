import type { WorkspaceFileChanges } from "@mcode/contracts";
import { buildFileTree, type TreeNode } from "@/lib/file-tree";

/** Git mark the Files tree shows beside a changed file. */
export type FileChangeMark = WorkspaceFileChanges["entries"][number]["mark"];

/** One visible row of the flattened Files tree. */
export type FileTreeRow =
  | {
      readonly kind: "folder";
      readonly path: string;
      /** Possibly compacted label, such as `src/stores`. */
      readonly name: string;
      readonly depth: number;
      readonly expanded: boolean;
      /** True when any file under this folder carries a change mark. */
      readonly hasChanges: boolean;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly mark: FileChangeMark | null;
    };

/** Change marks keyed by path, plus every folder that contains a change. */
export interface FileChangeIndex {
  readonly marks: ReadonlyMap<string, FileChangeMark>;
  readonly changedFolders: ReadonlySet<string>;
}

/** An index with no changes, used for non-git scopes and before marks load. */
export const EMPTY_CHANGE_INDEX: FileChangeIndex = { marks: new Map(), changedFolders: new Set() };

/** Indexes `file.changes` entries so rows can look up marks and folder dots. */
export function indexFileChanges(changes: WorkspaceFileChanges | null): FileChangeIndex {
  if (!changes || !changes.git) return EMPTY_CHANGE_INDEX;
  const marks = new Map<string, FileChangeMark>();
  const changedFolders = new Set<string>();
  for (const entry of changes.entries) {
    marks.set(entry.path, entry.mark);
    for (const folder of ancestorFolders(entry.path)) changedFolders.add(folder);
  }
  return { marks, changedFolders };
}

/** Every ancestor directory of `path`, shortest first (`a`, `a/b` for `a/b/c.ts`). */
export function ancestorFolders(path: string): string[] {
  const segments = path.split("/");
  const folders: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    folders.push(segments.slice(0, index).join("/"));
  }
  return folders;
}

/** Builds the compacted tree once per path list. */
export function buildFilesTree(paths: readonly string[]): TreeNode[] {
  return buildFileTree(paths);
}

function pushRows(
  nodes: readonly TreeNode[],
  depth: number,
  expanded: ReadonlySet<string>,
  changes: FileChangeIndex,
  rows: FileTreeRow[],
): void {
  for (const node of nodes) {
    if (node.type === "file") {
      rows.push({ kind: "file", path: node.path, name: node.name, depth, mark: changes.marks.get(node.path) ?? null });
      continue;
    }
    const isExpanded = expanded.has(node.path);
    rows.push({
      kind: "folder",
      path: node.path,
      name: node.name,
      depth,
      expanded: isExpanded,
      hasChanges: changes.changedFolders.has(node.path),
    });
    if (isExpanded) pushRows(node.children, depth + 1, expanded, changes, rows);
  }
}

/**
 * Flattens the tree into the rows a virtualized list renders. Collapsed
 * folders hide their subtree, so row count tracks what is on screen rather
 * than the size of the repository.
 */
export function flattenFileTree(
  tree: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  changes: FileChangeIndex,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  pushRows(tree, 0, expanded, changes, rows);
  return rows;
}

/**
 * Folder node paths to expand so `path` is visible. Compacted folders mean a
 * raw ancestor such as `a` may not be a node; only real node paths are
 * returned. `path` itself is included when it is a folder.
 */
export function folderNodesToReveal(tree: readonly TreeNode[], path: string): string[] {
  const result: string[] = [];
  let level: readonly TreeNode[] = tree;
  for (;;) {
    const next = level.find(
      (node) => node.type === "folder" && (path === node.path || path.startsWith(`${node.path}/`)),
    );
    if (!next || next.type !== "folder") return result;
    result.push(next.path);
    if (next.path === path) return result;
    level = next.children;
  }
}
