/**
 * Model cache data access layer.
 * Provides CRUD operations for the `provider_model_cache` SQLite table,
 * which persists per-provider model lists across app restarts.
 */

import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { ProviderModelInfo } from "@mcode/contracts";
import { providerModelCache } from "../../../../runtime/persistence/sqlite/schema.js";

/** A cached model list row from `provider_model_cache`. */
export interface CachedModelEntry {
  providerId: string;
  models: ProviderModelInfo[];
  fetchedAt: string;
  modelCount: number;
}

type CacheRow = typeof providerModelCache.$inferSelect;

/** Data access for the `provider_model_cache` SQLite table. */
@injectable()
export class ModelCacheRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Read cached models for a provider. Returns null if no cache entry exists. */
  get(providerId: string): CachedModelEntry | null {
    const row = this.orm
      .select()
      .from(providerModelCache)
      .where(eq(providerModelCache.providerId, providerId))
      .get();

    if (!row) return null;

    return rowToEntry(row);
  }

  /** Read all cached provider entries. Used at startup to pre-populate memory. */
  getAll(): CachedModelEntry[] {
    const rows = this.orm.select().from(providerModelCache).all();

    return rows.map(rowToEntry);
  }

  /** Insert or replace cached models for a provider. */
  upsert(providerId: string, models: ProviderModelInfo[]): void {
    this.orm
      .insert(providerModelCache)
      .values({
        providerId,
        modelsJson: JSON.stringify(models),
        fetchedAt: sql`datetime('now')`,
        modelCount: models.length,
      })
      .onConflictDoUpdate({
        target: providerModelCache.providerId,
        set: {
          modelsJson: sql`excluded.models_json`,
          fetchedAt: sql`excluded.fetched_at`,
          modelCount: sql`excluded.model_count`,
        },
      })
      .run();
  }

  /** Remove cached models for a provider (e.g. when provider is disabled). */
  delete(providerId: string): void {
    this.orm
      .delete(providerModelCache)
      .where(eq(providerModelCache.providerId, providerId))
      .run();
  }
}

function rowToEntry(row: CacheRow): CachedModelEntry {
  return {
    providerId: row.providerId,
    models: JSON.parse(row.modelsJson) as ProviderModelInfo[],
    fetchedAt: row.fetchedAt,
    modelCount: row.modelCount,
  };
}
