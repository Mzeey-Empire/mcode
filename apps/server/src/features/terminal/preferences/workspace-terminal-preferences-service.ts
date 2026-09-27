import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  TerminalProfileReferenceSchema,
  WorkspaceTerminalPreferenceSchema,
  type TerminalProfileReference,
  type WorkspaceTerminalPreference,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import {
  workspaceTerminalPreferences,
  workspaces,
} from "../../../runtime/persistence/sqlite/schema.js";

type WorkspaceTerminalPreferenceRow = typeof workspaceTerminalPreferences.$inferSelect;

/** Raised when a Terminal preference targets a missing workspace. */
export class TerminalWorkspaceNotFoundError extends Error {
  readonly code = "WORKSPACE_NOT_FOUND" as const;

  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} was not found`);
    this.name = "TerminalWorkspaceNotFoundError";
  }
}

/** Persists explicit workspace-only Terminal default-profile overrides. */
@injectable()
export class WorkspaceTerminalPreferencesService {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Returns the explicit override, or null when the workspace inherits the global default. */
  get(workspaceId: string): WorkspaceTerminalPreference | null {
    this.assertWorkspaceExists(workspaceId);
    const row = this.orm
      .select()
      .from(workspaceTerminalPreferences)
      .where(eq(workspaceTerminalPreferences.workspaceId, workspaceId))
      .get();
    return row ? this.parseRow(row) : null;
  }

  /** Creates or replaces one explicit workspace Terminal profile override. */
  update(
    workspaceId: string,
    defaultProfileId: TerminalProfileReference,
  ): WorkspaceTerminalPreference {
    this.assertWorkspaceExists(workspaceId);
    const profileId = TerminalProfileReferenceSchema().parse(defaultProfileId);
    const updatedAt = new Date().toISOString();
    this.orm
      .insert(workspaceTerminalPreferences)
      .values({
        workspaceId,
        defaultProfileId: profileId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: workspaceTerminalPreferences.workspaceId,
        set: { defaultProfileId: profileId, updatedAt },
      })
      .run();
    return WorkspaceTerminalPreferenceSchema().parse({
      workspaceId,
      defaultProfileId: profileId,
      updatedAt,
    });
  }

  /** Deletes one explicit override so the workspace inherits the global default. */
  reset(workspaceId: string): boolean {
    this.assertWorkspaceExists(workspaceId);
    return (
      runChanges(
        this.orm
          .delete(workspaceTerminalPreferences)
          .where(eq(workspaceTerminalPreferences.workspaceId, workspaceId)),
      ).changes > 0
    );
  }

  /** Lists workspace IDs that currently use the given profile as their default. */
  listReferences(profileId: TerminalProfileReference): string[] {
    const validated = TerminalProfileReferenceSchema().parse(profileId);
    return this.orm
      .select({ workspaceId: workspaceTerminalPreferences.workspaceId })
      .from(workspaceTerminalPreferences)
      .where(eq(workspaceTerminalPreferences.defaultProfileId, validated))
      .orderBy(asc(workspaceTerminalPreferences.workspaceId))
      .all()
      .map((row) => row.workspaceId);
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const workspace = this.orm
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .get();
    if (!workspace) {
      throw new TerminalWorkspaceNotFoundError(workspaceId);
    }
  }

  private parseRow(row: WorkspaceTerminalPreferenceRow): WorkspaceTerminalPreference {
    return WorkspaceTerminalPreferenceSchema().parse({
      workspaceId: row.workspaceId,
      defaultProfileId: row.defaultProfileId,
      updatedAt: row.updatedAt,
    });
  }
}
