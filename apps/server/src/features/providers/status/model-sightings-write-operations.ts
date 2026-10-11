import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ProviderIdSchema } from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ModelSightingsStore } from "./model-sightings-store.js";

/** Model sighting mutations admitted by the shared database owner. */
export const modelSightingsWriteOperations = {
  record: databaseWriteOperation("modelSightings.record", z.tuple([ProviderIdSchema, z.array(z.string()).max(4096), z.string().datetime()]), z.boolean()),
  acknowledge: databaseWriteOperation("modelSightings.acknowledge", z.tuple([ProviderIdSchema, z.string().datetime()]), z.boolean()),
};

/** Binds sighting writes to the sole writable connection. */
export function modelSightingsWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ModelSightingsStore(db);
  const operations = modelSightingsWriteOperations;
  return new Map([
    [operations.record.name, databaseWriteHandler(operations.record, (input) => store.record(...input))],
    [operations.acknowledge.name, databaseWriteHandler(operations.acknowledge, (input) => store.acknowledge(...input))],
  ]);
}
