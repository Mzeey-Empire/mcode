/**
 * Workspace data access layer.
 * Provides CRUD operations for workspace records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Workspace } from "@mcode/contracts";
import { threads, workspaces } from "../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
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
export class WorkspaceRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a new workspace and return the fully-populated record. */
  create(name: string, path: string, isGitRepo = true): Workspace {
    const id = NodeCrypto.randomUUID();
    const now = new Date().toISOString();

    this.orm.transaction((tx) => {
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
      tx
        .insert(workspaces)
        .values({
          id,
          name,
          path,
          isGitRepo: isGitRepo ? 1 : 0,
          createdAt: now,
          updatedAt: now,
          sortOrder: 0,
        })
        .run();
    });

    return {
      id,
      name,
      path,
      provider_config: {},
      is_git_repo: isGitRepo,
      created_at: now,
      updated_at: now,
      pinned: false,
      last_opened_at: null,
      sort_order: 0,
      deleted_at: null,
    };
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
    if (!normalized) {
      return this.orm
        .select()
        .from(workspaces)
        .where(isNull(workspaces.deletedAt))
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
          isNull(workspaces.deletedAt),
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

  /** Rename a non-deleted workspace and return its updated record. */
  rename(id: string, name: string): Workspace | null {
    const result = runChanges(this.orm
      .update(workspaces)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      );
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

  /** Permanently remove a workspace and all its children (via FK cascade). */
  hardDelete(id: string): boolean {
    const result = runChanges(this.orm
      .delete(workspaces)
      .where(eq(workspaces.id, id))
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
  findDeletingByPath(path: string): { id: string; path: string; deletedAt: string } | null {
    const row = this.orm
      .select({ id: workspaces.id, path: workspaces.path, deletedAt: workspaces.deletedAt })
      .from(workspaces)
      .where(and(eq(workspaces.path, path), isNotNull(workspaces.deletedAt)))
      .get();
    return (row ?? null) as { id: string; path: string; deletedAt: string } | null;
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
