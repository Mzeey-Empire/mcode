import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadProviderSessionStore } from "./thread-provider-session-store.js";

const sessionInput = z.object({
  threadId: z.string(),
  providerId: z.string(),
  sessionId: z.string().min(1),
  lastSeenSequence: z.number().int().nonnegative(),
});
const sequenceInput = z.tuple([z.string(), z.string(), z.number().int().nonnegative()]);
const keyInput = z.tuple([z.string(), z.string()]);

/** Allowlisted writes to per-provider thread sessions on the shared writer. */
export const threadProviderSessionWriteOperations = {
  upsert: databaseWriteOperation("threadProviderSession.upsert", z.tuple([sessionInput]), z.void()),
  markSeen: databaseWriteOperation("threadProviderSession.markSeen", sequenceInput, z.void()),
  remove: databaseWriteOperation("threadProviderSession.remove", keyInput, z.void()),
};

/** Register the per-provider session writes on the application writer connection. */
export function threadProviderSessionWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ThreadProviderSessionStore(db);
  const operations = threadProviderSessionWriteOperations;
  return new Map<string, (input: unknown) => unknown>([
    [operations.upsert.name, databaseWriteHandler(operations.upsert, ([input]) => store.upsert(input))],
    [operations.markSeen.name, databaseWriteHandler(operations.markSeen, (input) => store.markSeen(...input))],
    [operations.remove.name, databaseWriteHandler(operations.remove, (input) => store.remove(...input))],
  ]);
}
