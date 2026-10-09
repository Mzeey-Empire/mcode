import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { normalizePathForComparison } from "../../../../shared/filesystem/path-identity.js";
import { storeIdentity } from "../../../../runtime/persistence/sqlite/schema.js";
import {
  databaseWriteHandler,
  databaseWriteOperation,
} from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import type { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";

/** Validates the id that namespaces one database file's snapshot refs. */
export const StoreIdSchema = z.string().uuid().brand<"SnapshotStoreId">();

/** Identity of one database file, used as the `refs/mcode/<storeId>/` namespace. */
export type StoreId = z.infer<typeof StoreIdSchema>;

/** DI token for the store id of the database this server process opened. */
export const SNAPSHOT_STORE_ID = "SnapshotStoreId";

/** Return this file's store id, minting a new one when the file is not where the id was recorded. */
export const ensureStoreIdentity = databaseWriteOperation("snapshotStore.ensureIdentity", z.object({
  databasePath: z.string().min(1),
  candidateStoreId: StoreIdSchema,
  createdAt: z.string().min(1),
}).strict(), StoreIdSchema);

/** Construct store identity persistence against the writer connection. */
export function storeIdentityWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  return new Map([[ensureStoreIdentity.name, databaseWriteHandler(ensureStoreIdentity, (input) => {
    const rows = orm.select().from(storeIdentity).all();
    const current = rows.length === 1 ? rows[0] : undefined;
    if (current && current.databasePath === input.databasePath) return StoreIdSchema.parse(current.storeId);
    // A copied or moved file must not share refs with the original, so its identity is replaced.
    orm.delete(storeIdentity).run();
    orm.insert(storeIdentity).values({
      storeId: input.candidateStoreId,
      databasePath: input.databasePath,
      createdAt: input.createdAt,
    }).run();
    return input.candidateStoreId;
  })]]);
}

/** Resolve links and case so one physical database file has one recorded path. */
export function databaseFileIdentityPath(dbPath: string, platform: NodeJS.Platform): string {
  return normalizePathForComparison(NodeFS.realpathSync.native(dbPath), platform);
}

/** Read or mint the store id for the database file at `dbPath`. */
export function ensureSnapshotStoreId(
  writer: Pick<ApplicationDatabaseWriter, "execute">,
  dbPath: string,
  platform: NodeJS.Platform,
): Promise<StoreId> {
  return writer.execute(ensureStoreIdentity, {
    databasePath: databaseFileIdentityPath(dbPath, platform),
    candidateStoreId: StoreIdSchema.parse(NodeCrypto.randomUUID()),
    createdAt: new Date().toISOString(),
  });
}
