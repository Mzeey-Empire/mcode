/** Normalize persisted worktree paths for admission checks and setup serialization. */
export function normalizeWorktreePath(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
