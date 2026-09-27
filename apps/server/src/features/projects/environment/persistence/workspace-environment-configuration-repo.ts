import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { WorkspaceEnvironmentStorageMode } from "@mcode/contracts";
import {
  workspaceEnvironmentCommandApprovals,
  workspaceEnvironmentStorageSettings,
} from "../../../../runtime/persistence/sqlite/schema.js";

/** Persists one Project's active environment location and shared-command approvals. */
export class WorkspaceEnvironmentConfigurationRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Returns the explicit storage choice, if this Project has one. */
  storageMode(workspaceId: string): WorkspaceEnvironmentStorageMode | null {
    const row = this.orm
      .select({ storageMode: workspaceEnvironmentStorageSettings.storageMode })
      .from(workspaceEnvironmentStorageSettings)
      .where(eq(workspaceEnvironmentStorageSettings.workspaceId, workspaceId))
      .get();
    return row?.storageMode === "shared" || row?.storageMode === "system" ? row.storageMode : null;
  }

  /** Stores the exclusive environment location for one Project. */
  setStorageMode(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): void {
    this.orm
      .insert(workspaceEnvironmentStorageSettings)
      .values({
        workspaceId,
        storageMode,
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      })
      .onConflictDoUpdate({
        target: workspaceEnvironmentStorageSettings.workspaceId,
        set: {
          storageMode,
          updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        },
      })
      .run();
  }

  /** Reports whether this Project command has approval for the exact fingerprint. */
  hasApproval(workspaceId: string, commandId: string, fingerprint: string): boolean {
    const row = this.orm
      .select({ approved: sql<number>`1` })
      .from(workspaceEnvironmentCommandApprovals)
      .where(
        and(
          eq(workspaceEnvironmentCommandApprovals.workspaceId, workspaceId),
          eq(workspaceEnvironmentCommandApprovals.commandId, commandId),
          eq(workspaceEnvironmentCommandApprovals.fingerprint, fingerprint),
        ),
      )
      .get();
    return row?.approved === 1;
  }

  /** Replaces the approval for one stable Project command. */
  approve(workspaceId: string, commandId: string, fingerprint: string): void {
    this.orm
      .insert(workspaceEnvironmentCommandApprovals)
      .values({
        workspaceId,
        commandId,
        fingerprint,
        approvedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      })
      .onConflictDoUpdate({
        target: [
          workspaceEnvironmentCommandApprovals.workspaceId,
          workspaceEnvironmentCommandApprovals.commandId,
        ],
        set: {
          fingerprint,
          approvedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        },
      })
      .run();
  }

  /** Removes every stored command approval for one Project. */
  clearApprovals(workspaceId: string): void {
    this.orm
      .delete(workspaceEnvironmentCommandApprovals)
      .where(eq(workspaceEnvironmentCommandApprovals.workspaceId, workspaceId))
      .run();
  }
}
