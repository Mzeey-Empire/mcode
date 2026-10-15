import { buildPullRequestFileTree, flattenPullRequestFileTree } from "@/features/pull-requests";

/**
 * Orders changed files the way the Files tree lists them: folders before files,
 * numeric-aware names, single-child folders compacted. The diff, both Files hosts
 * and the Commit list read this one order, so a file sits in the same place everywhere.
 */
export function orderReviewFiles<T extends { readonly path: string }>(files: readonly T[]): T[] {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const rows = flattenPullRequestFileTree(buildPullRequestFileTree([...byPath.keys()]), new Set(), true);
  return rows.flatMap((row) => {
    const file = row.node.kind === "file" ? byPath.get(row.node.path) : undefined;
    return file ? [file] : [];
  });
}
