import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  databaseWriteHandler,
  databaseWriteOperation,
} from "../../../../../runtime/persistence/sqlite/database-write-operation.js";
import {
  CommitSettlementSchema,
  FinishedCommitPushSchema,
  PreparedCommitRequestInputSchema,
} from "../commit-request.js";
import { GitCommitRequestStore } from "./git-commit-request-store.js";

/** Commit request writes admitted to the shared database writer. */
export const gitCommitRequestWriteOperations = {
  insertPrepared: databaseWriteOperation("gitCommitRequest.insertPrepared", z.tuple([PreparedCommitRequestInputSchema]), z.void()),
  settle: databaseWriteOperation("gitCommitRequest.settle", z.tuple([z.string().min(1), CommitSettlementSchema]), z.boolean()),
  recordPush: databaseWriteOperation("gitCommitRequest.recordPush", z.tuple([z.string().min(1), FinishedCommitPushSchema]), z.boolean()),
  deleteExpired: databaseWriteOperation("gitCommitRequest.deleteExpired", z.tuple([z.number().int().nonnegative()]), z.number().int().nonnegative()),
};

/** Handlers for commit request writes on the writer connection. */
export function gitCommitRequestWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new GitCommitRequestStore(db);
  const operations = gitCommitRequestWriteOperations;
  return new Map([
    [operations.insertPrepared.name, databaseWriteHandler(operations.insertPrepared, (input) => store.insertPrepared(...input))],
    [operations.settle.name, databaseWriteHandler(operations.settle, (input) => store.settle(...input))],
    [operations.recordPush.name, databaseWriteHandler(operations.recordPush, (input) => store.recordPush(...input))],
    [operations.deleteExpired.name, databaseWriteHandler(operations.deleteExpired, (input) => store.deleteExpired(...input))],
  ]);
}
