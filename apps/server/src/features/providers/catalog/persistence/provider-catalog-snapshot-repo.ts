import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  ProviderCatalogSnapshotSchema,
  type ProviderCatalogSnapshot,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  providerCatalogSnapshots,
  workspaces,
} from "../../../../runtime/persistence/sqlite/schema.js";

const MAX_PERSISTED_CONTEXTS_PER_PROVIDER = 512;

/** Persists bounded provider catalog snapshots by realized discovery context. */
@injectable()
export class ProviderCatalogSnapshotRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Returns one validated snapshot, or null when the row is absent or corrupt. */
  get(contextKey: string): ProviderCatalogSnapshot | null {
    const row = this.orm
      .select({ snapshotJson: providerCatalogSnapshots.snapshotJson })
      .from(providerCatalogSnapshots)
      .where(eq(providerCatalogSnapshots.contextKey, contextKey))
      .get();
    if (!row) return null;

    try {
      return ProviderCatalogSnapshotSchema().parse(JSON.parse(row.snapshotJson));
    } catch (error) {
      logger.warn("Ignoring invalid provider catalog snapshot", {
        contextKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Inserts or replaces a validated snapshot when its workspace still exists. */
  upsert(
    contextKey: string,
    workspaceId: string | undefined,
    cwd: string | undefined,
    snapshot: ProviderCatalogSnapshot,
  ): boolean {
    const validated = ProviderCatalogSnapshotSchema().parse(snapshot);
    // Reading the workspace before acquiring a write lock can fail a later WAL snapshot upgrade.
    return this.orm.transaction((tx) => {
      // The legacy INSERT...SELECT only wrote when the referenced workspace
      // still existed, so a dangling workspaceId must abort with no changes.
      if (workspaceId !== undefined) {
        const workspace = tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .get();
        if (!workspace) return false;
      }
      tx.insert(providerCatalogSnapshots)
        .values({
          contextKey,
          providerId: validated.providerId,
          workspaceId: workspaceId ?? null,
          cwd: cwd ?? null,
          snapshotJson: JSON.stringify(validated),
          updatedAt: sql`datetime('now')`,
        })
        .onConflictDoUpdate({
          target: providerCatalogSnapshots.contextKey,
          set: {
            providerId: validated.providerId,
            workspaceId: workspaceId ?? null,
            cwd: cwd ?? null,
            snapshotJson: JSON.stringify(validated),
            updatedAt: sql`datetime('now')`,
          },
        })
        .run();
      tx.delete(providerCatalogSnapshots)
        .where(
          inArray(
            providerCatalogSnapshots.contextKey,
            tx
              .select({ contextKey: providerCatalogSnapshots.contextKey })
              .from(providerCatalogSnapshots)
              .where(eq(providerCatalogSnapshots.providerId, validated.providerId))
              .orderBy(
                desc(providerCatalogSnapshots.updatedAt),
                desc(providerCatalogSnapshots.contextKey),
              )
              // drizzle drops limit(-1), emitting a bare OFFSET which is invalid
              .limit(Number.MAX_SAFE_INTEGER)
              .offset(MAX_PERSISTED_CONTEXTS_PER_PROVIDER),
          ),
        )
        .run();
      return true;
    }, { behavior: "immediate" });
  }
}
