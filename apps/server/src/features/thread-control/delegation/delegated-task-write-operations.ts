import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { DelegatedTaskSchema, DelegatedTaskStore, NoticeCandidateSchema } from "./delegated-task-store.js";

/** Receipt claims cross the writer boundary as a single complete operation. */
export const claimDelegatedTask = databaseWriteOperation("delegatedTask.claim",
  z.tuple([DelegatedTaskSchema.omit({ taskId: true, createdAt: true, noticeDelivered: true, noticeClaim: true })]),
  z.union([
    z.object({ kind: z.enum(["claimed", "existing"]), task: DelegatedTaskSchema }),
    z.object({ kind: z.literal("conflict") }),
  ]));

/** Reserve a batch against its observed delivered keys. */
export const claimTaskNotices = databaseWriteOperation("delegatedTask.claimNotices",
  z.tuple([z.string().uuid(), z.array(NoticeCandidateSchema)]), z.array(z.string()));
/** Commit a delivered batch without overwriting concurrent reads. */
export const settleTaskNotices = databaseWriteOperation("delegatedTask.settleNotices", z.string().uuid(), z.void());
/** Return an unaccepted batch. */
export const returnTaskNotices = databaseWriteOperation("delegatedTask.returnNotices", z.string().uuid(), z.void());
/** Acknowledge a task result returned to its Coordinator. */
export const acknowledgeTaskNotice = databaseWriteOperation("delegatedTask.acknowledge",
  z.tuple([z.string(), z.string()]), z.void());

/** Register the receipt claim on the sole writable SQLite connection. */
export function delegatedTaskWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new DelegatedTaskStore(db);
  return new Map([
    [claimDelegatedTask.name, databaseWriteHandler(claimDelegatedTask, ([input]) => store.claim(input))],
    [claimTaskNotices.name, databaseWriteHandler(claimTaskNotices, ([wakeId, candidates]) => store.claimNotices(wakeId, candidates))],
    [settleTaskNotices.name, databaseWriteHandler(settleTaskNotices, (wakeId) => store.settleNotices(wakeId))],
    [returnTaskNotices.name, databaseWriteHandler(returnTaskNotices, (wakeId) => store.returnNotices(wakeId))],
    [acknowledgeTaskNotice.name, databaseWriteHandler(acknowledgeTaskNotice, ([taskId, key]) => store.acknowledge(taskId, key))],
  ]);
}
