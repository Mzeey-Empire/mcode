import { z } from "zod";
import type { Database } from "bun:sqlite";
import { ProviderModelInfoSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { ModelCacheStore } from "./model-cache-store.js";

/** Provider model cache mutations admitted by the shared database owner. */
export const modelCacheWriteOperations = {
  upsert: databaseWriteOperation("modelCache.upsert", z.tuple([z.string(), z.array(ProviderModelInfoSchema()).max(4096)]), z.void()),
  delete: databaseWriteOperation("modelCache.delete", z.tuple([z.string()]), z.void()),
};

/** Bind model cache writes to the sole writable connection. */
export function modelCacheWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ModelCacheStore(db);
  const operations = modelCacheWriteOperations;
  return new Map([
    [operations.upsert.name, databaseWriteHandler(operations.upsert, (input) => store.upsert(...input))],
    [operations.delete.name, databaseWriteHandler(operations.delete, (input) => store.delete(...input))],
  ]);
}
