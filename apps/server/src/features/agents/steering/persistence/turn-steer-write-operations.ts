import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  databaseWriteHandler,
  databaseWriteOperation,
} from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { PendingTurnSteerInputSchema, TurnSteerSettlementSchema } from "../turn-steer.js";
import { TurnSteerStore } from "./turn-steer-store.js";

const MessageId = z.string().uuid();
const Count = z.number().int().nonnegative();

/** Steer writes admitted to the shared database writer. */
export const turnSteerWriteOperations = {
  insertPending: databaseWriteOperation("turnSteer.insertPending", z.tuple([PendingTurnSteerInputSchema]), z.void()),
  settle: databaseWriteOperation("turnSteer.settle", z.tuple([MessageId, TurnSteerSettlementSchema]), z.boolean()),
  markDelivered: databaseWriteOperation("turnSteer.markDelivered", z.tuple([MessageId]), z.boolean()),
  requeue: databaseWriteOperation("turnSteer.requeue", z.tuple([MessageId, MessageId]), z.boolean()),
  remove: databaseWriteOperation("turnSteer.remove", z.tuple([MessageId]), z.boolean()),
  markPendingUnknown: databaseWriteOperation("turnSteer.markPendingUnknown", z.tuple([]), Count),
  deleteSettledOlderThan: databaseWriteOperation("turnSteer.deleteSettledOlderThan", z.tuple([Count]), Count),
};

/** Handlers for steer writes on the writer connection. */
export function turnSteerWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new TurnSteerStore(db);
  const operations = turnSteerWriteOperations;
  return new Map([
    [operations.insertPending.name, databaseWriteHandler(operations.insertPending, (input) => store.insertPending(...input))],
    [operations.settle.name, databaseWriteHandler(operations.settle, (input) => store.settle(...input))],
    [operations.markDelivered.name, databaseWriteHandler(operations.markDelivered, (input) => store.markDelivered(...input))],
    [operations.requeue.name, databaseWriteHandler(operations.requeue, (input) => store.requeue(...input))],
    [operations.remove.name, databaseWriteHandler(operations.remove, (input) => store.remove(...input))],
    [operations.markPendingUnknown.name, databaseWriteHandler(operations.markPendingUnknown, () => store.markPendingUnknown())],
    [operations.deleteSettledOlderThan.name,
      databaseWriteHandler(operations.deleteSettledOlderThan, (input) => store.deleteSettledOlderThan(...input))],
  ]);
}
