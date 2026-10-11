import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as NodeFSPromises from "node:fs/promises";
import { canonicalAgentTurns, threads, threadStartups, turnSnapshots } from "../../../../runtime/persistence/sqlite/schema.js";
import { attributedWorkspacePaths } from "../snapshots/snapshot-attribution.js";
import { resolveSnapshotCwd } from "../snapshots/resolve-snapshot-cwd.js";
import type { SnapshotRouterDeps } from "../transport/snapshot-rpc.js";
import type { ReadyRevertRange } from "./turn-revert-preview.js";
import { ReviewWorktreeMissingError } from "../../git/review-comparison-errors.js";

/** Resolve active turns and later attribution across every thread sharing this checkout. */
export function turnRevertContext(db: Database, deps: SnapshotRouterDeps, runtimeBusy: (threadId: string) => boolean) {
  const orm = drizzle(db);
  const resolveCwd = (threadId: string, worktreePath?: string | null) => resolveSnapshotCwd(deps, { thread_id: threadId, worktree_path: worktreePath ?? null });
  async function sameCwd(threadId: string, cwd: string, worktreePath?: string | null) {
    try { return await NodeFSPromises.realpath(resolveCwd(threadId, worktreePath)) === await NodeFSPromises.realpath(cwd); }
    catch (error) {
      if (error instanceof ReviewWorktreeMissingError) return false;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return {
    resolveCwd,
    async busy(cwd: string): Promise<boolean> {
      for (const thread of orm.select({ id: threads.id }).from(threads).all()) {
        if (!await sameCwd(thread.id, cwd)) continue;
        if (runtimeBusy(thread.id)) return true;
        if (orm.select({ id: canonicalAgentTurns.id }).from(canonicalAgentTurns).where(and(eq(canonicalAgentTurns.threadId, thread.id),
          inArray(canonicalAgentTurns.status, ["Pending", "Running"]))).get()) return true;
        if (orm.select({ id: threadStartups.startupId }).from(threadStartups).where(and(eq(threadStartups.threadId, thread.id),
          inArray(threadStartups.state, ["pending", "running", "blocked"]))).get()) return true;
      }
      return false;
    },
    async laterPaths(cwd: string, range: ReadyRevertRange): Promise<Set<string>> {
      const end = range.rows.at(-1);
      const paths = new Set<string>();
      if (!end) return paths;
      const later = orm.select({ id: turnSnapshots.id, threadId: turnSnapshots.threadId, worktreePath: turnSnapshots.worktreePath })
        .from(turnSnapshots).where(gt(turnSnapshots.createdAt, end.created_at)).all();
      for (const row of later) {
        if (range.rows.some((member) => member.id === row.id) || !await sameCwd(row.threadId, cwd, row.worktreePath)) continue;
        const snapshot = deps.turnSnapshotRepo.getById(row.id);
        if (snapshot) attributedWorkspacePaths(snapshot).forEach((name) => paths.add(name));
      }
      return paths;
    },
  };
}
