import { z } from "zod";
import type { Database } from "bun:sqlite";
import { ProviderCatalogSnapshotSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { ProviderCatalogSnapshotStore } from "./provider-catalog-snapshot-store.js";

/** Snapshot validation, workspace admission and bounded eviction in one transaction. */
export const providerCatalogSnapshotWriteOperations = {
  upsert: databaseWriteOperation("providerCatalogSnapshot.upsert", z.tuple([z.string(), z.string().optional(), z.string().optional(), ProviderCatalogSnapshotSchema()]), z.boolean()),
};

/** Bind catalog snapshot writes to the sole writable connection. */
export function providerCatalogSnapshotWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ProviderCatalogSnapshotStore(db);
  const operation = providerCatalogSnapshotWriteOperations.upsert;
  return new Map([[operation.name, databaseWriteHandler(operation, (input) => store.upsert(...input))]]);
}
