import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { ProviderId } from "@mcode/contracts";
import { providerModelSightings } from "../../../runtime/persistence/sqlite/schema.js";

// Large batches usually mean a fallback catalog switched to a live source, not simultaneous launches.
const MAX_NEW_MODELS_PER_REFRESH = 5;

/** Queries and owner-side mutations for durable provider model sightings. */
export class ModelSightingsStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Returns unacknowledged models newest first, with stable ordering for tied timestamps. */
  listOpen(providerId: ProviderId): Array<typeof providerModelSightings.$inferSelect> {
    return this.orm.select().from(providerModelSightings)
      .where(and(eq(providerModelSightings.providerId, providerId), isNull(providerModelSightings.acknowledgedAt)))
      .orderBy(desc(providerModelSightings.firstSeenAt), asc(providerModelSightings.modelId)).all();
  }

  /** Inserts unseen ids atomically within the database writer's transaction. */
  record(providerId: ProviderId, modelIds: string[], now: string): boolean {
    if (modelIds.length === 0) return false;
    const existing = this.orm.select({ modelId: providerModelSightings.modelId })
      .from(providerModelSightings).where(eq(providerModelSightings.providerId, providerId)).all();
    const known = new Set(existing.map((row) => row.modelId));
    const unseen = [...new Set(modelIds)].filter((modelId) => !known.has(modelId));
    const acknowledgedAt = existing.length === 0 || unseen.length > MAX_NEW_MODELS_PER_REFRESH ? now : null;
    let changed = false;
    for (const modelId of unseen) {
      const inserted = this.orm.insert(providerModelSightings)
        .values({ providerId, modelId, firstSeenAt: now, acknowledgedAt })
        .onConflictDoNothing().returning({ modelId: providerModelSightings.modelId }).all();
      changed = inserted.length > 0 || changed;
    }
    return changed;
  }

  /** Acknowledges all currently open sightings without altering earlier acknowledgements. */
  acknowledge(providerId: ProviderId, now: string): boolean {
    return this.orm.update(providerModelSightings).set({ acknowledgedAt: now })
      .where(and(eq(providerModelSightings.providerId, providerId), isNull(providerModelSightings.acknowledgedAt)))
      .returning({ modelId: providerModelSightings.modelId }).all().length > 0;
  }
}
