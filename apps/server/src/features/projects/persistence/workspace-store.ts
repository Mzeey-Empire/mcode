/**
 * Workspace data access layer.
 * Provides CRUD operations for workspace records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Workspace } from "@mcode/contracts/models/workspace";
import { threads, threadStartups, workspaces } from "../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    kind: row.kind,
    provider_config: JSON.parse(row.providerConfig) as Record<
      string,
      unknown
    >,
    is_git_repo: row.isGitRepo === 1,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    pinned: row.pinned === 1,
    last_opened_at: normalizeLastOpenedAt(row.lastOpenedAt),
    sort_order: row.sortOrder,
    deleted_at: row.deletedAt ?? null,
    icon_path: row.iconPath ?? null,
  };
}

function normalizeLastOpenedAt(value: number | string | null): number | null {
  if (value === null || typeof value === "number") return value;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("Workspace last_opened_at is not a Unix timestamp or ISO date.");
  return timestamp;
}

/** Repository for workspace CRUD operations against SQLite. */
@injectable()
export class WorkspaceStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a new workspace and return the fully-populated record. */
  create(name: string, path: string, isGitRepo = true, kind: Workspace["kind"] = "project"): Workspace {
    const id = NodeCrypto.randomUUID();
    const now = new Date().toISOString();

    return this.orm.transaction((tx) => {
      // Evict a soft-deleted row occupying this path only if it has no remaining
      // child threads (i.e. async cleanup already finished). If threads still
      // exist the CleanupWorker will hard-delete the workspace once done.
      const stale = tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.path, path), isNotNull(workspaces.deletedAt)))
        .get();
      if (stale) {
        const threadCount = tx
          .select({ n: count() })
          .from(threads)
          .where(eq(threads.workspaceId, stale.id))
          .get();
        if (threadCount?.n === 0) {
          tx.delete(workspaces).where(eq(workspaces.id, stale.id)).run();
        }
      }
      tx
        .update(workspaces)
        .set({ sortOrder: sql`${workspaces.sortOrder} + 1` })
        .run();
      const row = tx
        .insert(workspaces)
        .values({
          id,
          name,
          path,
          kind,
          isGitRepo: isGitRepo ? 1 : 0,
          createdAt: now,
          updatedAt: now,
          sortOrder: 0,
        })
        .returning().get();
      return rowToWorkspace(row);
    });
  }

  /** Move an existing workspace to the top of the sidebar (sort_order 0). */
  prependToSortOrder(id: string): void {
    const row = this.orm
      .select({ sortOrder: workspaces.sortOrder })
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    if (!row || row.sortOrder === 0) return;

    this.orm.transaction((tx) => {
      tx
        .update(workspaces)
        .set({ sortOrder: sql`${workspaces.sortOrder} + 1` })
        .where(lt(workspaces.sortOrder, row.sortOrder))
        .run();
      tx
        .update(workspaces)
        .set({ sortOrder: 0 })
        .where(eq(workspaces.id, id))
        .run();
    });
  }

  /**
   * Reorder a workspace to a zero-based index in the current sort_order ordering.
   * Rebuilds sequential sort_order values to handle duplicates from legacy migrations.
   */
  reorderToIndex(id: string, newIndex: number): void {
    const rows = this.orm
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.kind, "project"), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.sortOrder), asc(workspaces.id))
      .all();

    const oldIdx = rows.findIndex((r) => r.id === id);
    if (oldIdx < 0) return;

    const n = rows.length;
    const idx = Math.max(0, Math.min(newIndex, n - 1));
    if (oldIdx === idx) return;

    const ids = rows.map((r) => r.id);
    const [moved] = ids.splice(oldIdx, 1);
    ids.splice(idx, 0, moved!);

    this.orm.transaction((tx) => {
      for (let i = 0; i < ids.length; i++) {
        tx
          .update(workspaces)
          .set({ sortOrder: i })
          .where(eq(workspaces.id, ids[i]!))
          .run();
      }
    });
  }

  /** Find a workspace by its primary key. Returns null if not found or soft-deleted. */
  findById(id: string): Workspace | null {
    const row = this.orm
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      .get();

    return row ? rowToWorkspace(row) : null;
  }

  /** Find a workspace by its filesystem path. Returns null if not found or soft-deleted. */
  findByPath(path: string): Workspace | null {
    const row = this.orm
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.path, path), isNull(workspaces.deletedAt)))
      .get();

    return row ? rowToWorkspace(row) : null;
  }

  /** List all non-deleted workspaces ordered by ascending sidebar sort_order. */
  listAll(): Workspace[] {
    const rows = this.orm
      .select()
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(asc(workspaces.sortOrder), asc(workspaces.id))
      .all();

    return rows.map(rowToWorkspace);
  }

  /** Search registered non-deleted workspaces by name or repository path. */
  search(query: string, limit: number): Workspace[] {
    const normalized = query.trim();
    const liveProjects = and(isNull(workspaces.deletedAt), eq(workspaces.kind, "project"));
    if (!normalized) {
      return this.orm
        .select()
        .from(workspaces)
        .where(liveProjects)
        .orderBy(
          sql`${workspaces.lastOpenedAt} DESC NULLS LAST`,
          desc(workspaces.updatedAt),
          asc(workspaces.id),
        )
        .limit(limit)
        .all()
        .map(rowToWorkspace);
    }
    const pattern = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
    return this.orm
      .select()
      .from(workspaces)
      .where(
        and(
          liveProjects,
          or(
            sql`${workspaces.name} LIKE ${pattern} ESCAPE '\\'`,
            sql`${workspaces.path} LIKE ${pattern} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(
        sql`${workspaces.lastOpenedAt} DESC NULLS LAST`,
        desc(workspaces.updatedAt),
        asc(workspaces.id),
      )
      .limit(limit)
      .all()
      .map(rowToWorkspace);
  }

  /** Insert an isolated workspace without changing the project order. */
  createNoProject(id: string, path: string): { workspace: Workspace; inserted: boolean } {
    const now = new Date().toISOString();
    const inserted = this.orm.insert(workspaces)
      .values({ id, path, name: "No project", isGitRepo: 0, kind: "no_project", createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning().get();
    if (!inserted) throw new Error(`Workspace ID or path already exists: ${id}`);
    return { workspace: rowToWorkspace(inserted), inserted: true };
  }

  /** List registered paths, including those still held by soft-deleted rows. */
  listPathsIncludeDeleted(): string[] {
    return this.orm.select({ path: workspaces.path }).from(workspaces).all().map(({ path }) => path);
  }

  /** Find every pre-thread failure that should retire when a No project thread is deleted. */
  findThreadlessNoProjectFailureIds(workspaceId: string): string[] {
    return this.orm.select({ id: threadStartups.startupId }).from(threadStartups)
      .innerJoin(workspaces, eq(threadStartups.workspaceId, workspaces.id))
      .where(and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.kind, "no_project"),
        isNull(threadStartups.threadId),
        inArray(threadStartups.state, ["failed", "interrupted"]),
      )).all().map(({ id }) => id);
  }

  /** Find old No project workspaces without any thread or startup that can still use them. */
  findRemovableNoProject(createdBefore: string, retryUpdatedSince: string): Workspace[] {
    return this.orm.select().from(workspaces)
      .where(this.removableNoProject(createdBefore, retryUpdatedSince)).all().map(rowToWorkspace);
  }

  /** Recheck eligibility on the writer connection before deleting a swept workspace. */
  deleteRemovableNoProject(id: string, createdBefore: string, retryUpdatedSince: string): boolean {
    return runChanges(this.orm.delete(workspaces)
      .where(and(eq(workspaces.id, id), this.removableNoProject(createdBefore, retryUpdatedSince)))).changes > 0;
  }

  private removableNoProject(createdBefore: string, retryUpdatedSince: string) {
    return and(
      eq(workspaces.kind, "no_project"),
      lt(workspaces.createdAt, createdBefore),
      notExists(this.orm.select({ id: threads.id }).from(threads)
        .where(eq(threads.workspaceId, workspaces.id))),
      notExists(this.orm.select({ id: threadStartups.startupId }).from(threadStartups)
        .where(and(eq(threadStartups.workspaceId, workspaces.id), or(
          inArray(threadStartups.state, ["pending", "running", "blocked"]),
          // A deleted thread's foreign key is cleared too, but setup and agent need a thread.
          // Acknowledging the trail leaves a pre-thread retry available.
          and(
            isNull(threadStartups.threadId),
            inArray(threadStartups.phase, ["thread", "fetch", "worktree"]),
            inArray(threadStartups.state, ["failed", "interrupted"]),
            gte(threadStartups.updatedAt, retryUpdatedSince),
            or(
              sql`json_extract(${threadStartups.errorJson}, '$.retryable') = 1`,
              and(
                eq(threadStartups.state, "interrupted"),
                eq(threadStartups.cancellation, "none"),
                isNull(threadStartups.errorJson),
              ),
            ),
          ),
        )))),
    );
  }

  /** Rename a non-deleted workspace and return its updated record. */
  rename(id: string, name: string): Workspace | null {
    const result = runChanges(this.orm
      .update(workspaces)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      );
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Store or clear the chosen icon path of a non-deleted workspace and return its updated record. */
  setIconPath(id: string, iconPath: string | null): Workspace | null {
    const result = runChanges(this.orm
      .update(workspaces)
      .set({ iconPath, updatedAt: new Date().toISOString() })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt))));
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Set the pinned flag for a workspace. Pinned workspaces always sort above recents. */
  setPinned(id: string, pinned: boolean): void {
    this.orm
      .update(workspaces)
      .set({ pinned: pinned ? 1 : 0 })
      .where(eq(workspaces.id, id))
      .run();
  }

  /** Update last_opened_at to now without touching updated_at. Used to track recency separately from edits. */
  touchLastOpened(id: string): void {
    this.orm
      .update(workspaces)
      .set({ lastOpenedAt: Date.now() })
      .where(eq(workspaces.id, id))
      .run();
  }

  /** Clear last_opened_at and pinned, removing the workspace from the recents/pinned list. */
  removeRecent(id: string): void {
    this.orm
      .update(workspaces)
      .set({ lastOpenedAt: null, pinned: 0 })
      .where(eq(workspaces.id, id))
      .run();
  }

  /** Soft-delete a workspace by setting deleted_at. Returns true if a row was changed. */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(workspaces)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      );
    return result.changes > 0;
  }

  /** Hard-delete a workspace, guarding No project creation rollback against concurrent use. */
  hardDelete(id: string): boolean {
    const result = runChanges(this.orm
      .delete(workspaces)
      .where(and(eq(workspaces.id, id), or(
        eq(workspaces.kind, "project"),
        and(
          notExists(this.orm.select({ id: threads.id }).from(threads).where(eq(threads.workspaceId, workspaces.id))),
          notExists(this.orm.select({ id: threadStartups.startupId }).from(threadStartups)
            .where(eq(threadStartups.workspaceId, workspaces.id))),
        ),
      )))
      );
    return result.changes > 0;
  }

  /** Find all workspaces currently in the soft-deleted (deleting) state. */
  findDeleting(): Array<{ id: string; path: string; deletedAt: string }> {
    return this.orm
      .select({ id: workspaces.id, path: workspaces.path, deletedAt: workspaces.deletedAt })
      .from(workspaces)
      .where(isNotNull(workspaces.deletedAt))
      .all() as Array<{ id: string; path: string; deletedAt: string }>;
  }

  /** Find a single soft-deleted workspace by path. O(1) lookup for finalization. */
  findDeletingByPath(path: string): Pick<WorkspaceRow, "id" | "path" | "kind"> & { deletedAt: string } | null {
    const row = this.orm
      .select({ id: workspaces.id, path: workspaces.path, kind: workspaces.kind, deletedAt: workspaces.deletedAt })
      .from(workspaces)
      .where(and(eq(workspaces.path, path), isNotNull(workspaces.deletedAt)))
      .get();
    if (!row || row.deletedAt === null) return null;
    return { ...row, deletedAt: row.deletedAt };
  }

  /** Find a workspace by ID regardless of deletion status. Used during cleanup. */
  findByIdIncludeDeleted(id: string): Workspace | null {
    const row = this.orm
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    return row ? rowToWorkspace(row) : null;
  }

  /** Bump updated_at to the current time so the workspace sorts to the top of the recent list. */
  touch(id: string): void {
    this.orm
      .update(workspaces)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(workspaces.id, id))
      .run();
  }

  /** Update the is_git_repo flag (e.g. after the user runs `git init`). */
  setIsGitRepo(id: string, isGitRepo: boolean): void {
    this.orm
      .update(workspaces)
      .set({ isGitRepo: isGitRepo ? 1 : 0 })
      .where(eq(workspaces.id, id))
      .run();
  }
}
