import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { workspaceWorktrees } from "../../../runtime/persistence/sqlite/schema.js";

/** Number of days to retain a stale worktree registration for identity revival. */
export const STALE_WORKTREE_RETENTION_DAYS = 30;
const STALE_WORKTREE_RETENTION_MS = STALE_WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Worktree metadata safe to expose outside the server. */
export interface RegisteredWorktree {
  worktreeId: string;
  label: string;
  branch?: string;
  baseRef?: string;
}

/** Server-side worktree registration input. */
export interface RegisteredWorktreeInput {
  canonicalPath: string;
  label: string;
  branch?: string;
  baseRef?: string;
  managed: boolean;
}

/** Server-only worktree registration including its canonical path and ownership. */
export interface InternalRegisteredWorktree extends RegisteredWorktree {
  workspaceId: string;
  canonicalPath: string;
  managed: boolean;
}

/** Repository for stable workspace-scoped worktree identities. */
@injectable()
export class WorktreeRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Reconcile current Git registrations and return opaque display metadata. */
  reconcile(workspaceId: string, worktrees: readonly RegisteredWorktreeInput[]): RegisteredWorktree[] {
    const now = new Date();
    const lastSeenAt = now.toISOString();
    const staleCutoff = new Date(now.getTime() - STALE_WORKTREE_RETENTION_MS).toISOString();
    this.orm.transaction((tx) => {
      tx
        .update(workspaceWorktrees)
        .set({ stale: 1 })
        .where(eq(workspaceWorktrees.workspaceId, workspaceId))
        .run();
      for (const worktree of worktrees) {
        tx
          .insert(workspaceWorktrees)
          .values({
            id: NodeCrypto.randomUUID(),
            workspaceId,
            canonicalPath: worktree.canonicalPath,
            label: worktree.label,
            branch: worktree.branch ?? null,
            baseRef: worktree.baseRef ?? null,
            managed: worktree.managed ? 1 : 0,
            lastSeenAt,
            stale: 0,
          })
          .onConflictDoUpdate({
            target: [workspaceWorktrees.workspaceId, workspaceWorktrees.canonicalPath],
            set: {
              label: worktree.label,
              branch: worktree.branch ?? null,
              baseRef: worktree.baseRef ?? null,
              managed: worktree.managed ? 1 : 0,
              lastSeenAt,
              stale: 0,
            },
          })
          .run();
      }
      tx
        .delete(workspaceWorktrees)
        .where(
          and(
            eq(workspaceWorktrees.workspaceId, workspaceId),
            eq(workspaceWorktrees.stale, 1),
            lt(workspaceWorktrees.lastSeenAt, staleCutoff),
          ),
        )
        .run();
    });
    return this.list(workspaceId);
  }

  /** List only current worktrees, never their canonical filesystem paths. */
  list(workspaceId: string): RegisteredWorktree[] {
    return this.orm
      .select({
        worktreeId: workspaceWorktrees.id,
        label: workspaceWorktrees.label,
        branch: workspaceWorktrees.branch,
        baseRef: workspaceWorktrees.baseRef,
      })
      .from(workspaceWorktrees)
      .where(and(eq(workspaceWorktrees.workspaceId, workspaceId), eq(workspaceWorktrees.stale, 0)))
      .orderBy(sql`${workspaceWorktrees.label} COLLATE NOCASE`, asc(workspaceWorktrees.id))
      .all()
      .map((value) => ({
        worktreeId: value.worktreeId,
        label: value.label,
        ...(value.branch ? { branch: value.branch } : {}),
        ...(value.baseRef ? { baseRef: value.baseRef } : {}),
      }));
  }

  /** Resolve one current opaque worktree only within the supplied workspace. */
  findCurrentById(workspaceId: string, worktreeId: string): InternalRegisteredWorktree | null {
    const row = this.orm
      .select({
        worktreeId: workspaceWorktrees.id,
        workspaceId: workspaceWorktrees.workspaceId,
        canonicalPath: workspaceWorktrees.canonicalPath,
        label: workspaceWorktrees.label,
        branch: workspaceWorktrees.branch,
        baseRef: workspaceWorktrees.baseRef,
        managed: workspaceWorktrees.managed,
      })
      .from(workspaceWorktrees)
      .where(
        and(
          eq(workspaceWorktrees.workspaceId, workspaceId),
          eq(workspaceWorktrees.id, worktreeId),
          eq(workspaceWorktrees.stale, 0),
        ),
      )
      .get();
    if (!row) return null;
    return {
      worktreeId: row.worktreeId,
      workspaceId: row.workspaceId,
      canonicalPath: row.canonicalPath,
      label: row.label,
      managed: row.managed === 1,
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.baseRef ? { baseRef: row.baseRef } : {}),
    };
  }

  /** Register one newly provisioned worktree without invalidating sibling registrations. */
  register(workspaceId: string, worktree: RegisteredWorktreeInput): RegisteredWorktree {
    const id = NodeCrypto.randomUUID();
    const lastSeenAt = new Date().toISOString();
    this.orm
      .insert(workspaceWorktrees)
      .values({
        id,
        workspaceId,
        canonicalPath: worktree.canonicalPath,
        label: worktree.label,
        branch: worktree.branch ?? null,
        baseRef: worktree.baseRef ?? null,
        managed: worktree.managed ? 1 : 0,
        lastSeenAt,
        stale: 0,
      })
      .onConflictDoUpdate({
        target: [workspaceWorktrees.workspaceId, workspaceWorktrees.canonicalPath],
        set: {
          label: worktree.label,
          branch: worktree.branch ?? null,
          baseRef: worktree.baseRef ?? null,
          managed: worktree.managed ? 1 : 0,
          lastSeenAt,
          stale: 0,
        },
      })
      .run();
    const row = this.orm
      .select({
        worktreeId: workspaceWorktrees.id,
        label: workspaceWorktrees.label,
        branch: workspaceWorktrees.branch,
        baseRef: workspaceWorktrees.baseRef,
      })
      .from(workspaceWorktrees)
      .where(
        and(
          eq(workspaceWorktrees.workspaceId, workspaceId),
          eq(workspaceWorktrees.canonicalPath, worktree.canonicalPath),
        ),
      )
      .get();
    return {
      worktreeId: row!.worktreeId,
      label: row!.label,
      ...(row!.branch ? { branch: row!.branch } : {}),
      ...(row!.baseRef ? { baseRef: row!.baseRef } : {}),
    };
  }
}
