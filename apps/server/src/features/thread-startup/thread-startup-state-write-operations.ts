import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  ThreadSchema, ThreadStartupSchema, ThreadStartupStartInputSchema, ThreadStartupPhaseSchema,
  ThreadStartupBlockSchema, ThreadStartupErrorSchema, THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS,
  type ThreadStartup,
  ThreadStartupStepDetailSchema,
} from "@mcode/contracts";
import { databaseWriteHandler, databaseWriteOperation } from "../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadStore } from "../thread-control/persistence/thread-store.js";
import { threadWriteOperations } from "../thread-control/persistence/thread-write-operations.js";
import { ThreadStartupStore } from "./persistence/thread-startup-store.js";
import { threadStartupWriteOperations } from "./persistence/thread-startup-write-operations.js";
import { ThreadStartupStateStore } from "./thread-startup-state-store.js";

const snapshot = ThreadStartupSchema();
const committed = z.object({ startup: snapshot, changed: z.boolean() }).strict();
const clock = z.string().datetime();
const id = z.tuple([z.string()]);
const creation = z.object({ args: threadWriteOperations.create.input, worktreePath: z.string().optional() }).strict();

/** A committed state transition eligible for main-thread publication. */
export type ThreadStartupCommittedTransition = z.infer<typeof committed>;

function transition<Input>(name: string, input: z.ZodType<Input>) {
  return databaseWriteOperation(name, input, committed);
}

/** Complete state-machine operations admitted by the shared database owner. */
export const threadStartupStateWriteOperations = {
  start: transition("threadStartup.start", z.tuple([z.tuple([ThreadStartupStartInputSchema(), z.string().max(4096).optional()]), clock])),
  advance: transition("threadStartup.advance", z.tuple([z.tuple([z.string(), ThreadStartupPhaseSchema, ThreadStartupStepDetailSchema().optional()]), clock])),
  bindThread: transition("threadStartup.bindThread", z.tuple([z.tuple([z.string(), z.string()]), clock])),
  clearThreadBinding: transition("threadStartup.clearThreadBinding", z.tuple([id, clock])),
  appendOutput: transition("threadStartup.appendOutput", z.tuple([z.tuple([z.string(), z.string().max(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS)]), clock])),
  complete: transition("threadStartup.complete", z.tuple([id, clock])),
  block: transition("threadStartup.block", z.tuple([z.tuple([z.string(), ThreadStartupBlockSchema(), ThreadStartupStepDetailSchema().optional()]), clock])),
  resume: transition("threadStartup.resume", z.tuple([id, clock])),
  skip: transition("threadStartup.skip", z.tuple([z.tuple([z.string(), ThreadStartupPhaseSchema, ThreadStartupStepDetailSchema().optional()]), clock])),
  fail: transition("threadStartup.fail", z.tuple([z.tuple([z.string(), ThreadStartupErrorSchema(), ThreadStartupStepDetailSchema().optional()]), clock])),
  cancel: transition("threadStartup.cancel", z.tuple([id, clock])),
  markCancelled: transition("threadStartup.markCancelled", z.tuple([id, clock])),
  createAndBindThread: databaseWriteOperation("threadStartup.createAndBindThread", z.tuple([z.string(), creation, clock]), committed.extend({ thread: ThreadSchema() })),
  interruptBatch: databaseWriteOperation("threadStartup.interruptBatch", z.tuple([z.string().optional(), clock]), z.object({ records: z.array(snapshot).max(100), nextCursor: z.string().nullable() }).strict()),
};

/** Bind raw snapshot and complete state transitions to the worker's writable connection. */
export function threadStartupWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ThreadStartupStore(db);
  const state = (timestamp: string) => new ThreadStartupStateStore(store, () => new Date(timestamp), new ThreadStore(db));
  const operations = threadStartupStateWriteOperations;
  const mutate = (startupId: string, action: () => ThreadStartup): ThreadStartupCommittedTransition => {
    const previous = store.findById(startupId);
    const startup = action();
    return { startup, changed: previous?.revision !== startup.revision };
  };
  return new Map([
    [threadStartupWriteOperations.insert.name, databaseWriteHandler(threadStartupWriteOperations.insert, (input) => store.insert(...input))],
    [threadStartupWriteOperations.update.name, databaseWriteHandler(threadStartupWriteOperations.update, (input) => store.update(...input))],
    [operations.start.name, databaseWriteHandler(operations.start, (input) => mutate(input[0][0].startupId, () => state(input[1]).start(...input[0])))],
    [operations.advance.name, databaseWriteHandler(operations.advance, (input) => mutate(input[0][0], () => state(input[1]).advance(...input[0])))],
    [operations.bindThread.name, databaseWriteHandler(operations.bindThread, (input) => mutate(input[0][0], () => state(input[1]).bindThread(...input[0])))],
    [operations.clearThreadBinding.name, databaseWriteHandler(operations.clearThreadBinding, (input) => mutate(input[0][0], () => state(input[1]).clearThreadBinding(...input[0])))],
    [operations.appendOutput.name, databaseWriteHandler(operations.appendOutput, (input) => mutate(input[0][0], () => state(input[1]).appendOutput(...input[0])))],
    [operations.complete.name, databaseWriteHandler(operations.complete, (input) => mutate(input[0][0], () => state(input[1]).complete(...input[0])))],
    [operations.block.name, databaseWriteHandler(operations.block, (input) => mutate(input[0][0], () => state(input[1]).block(...input[0])))],
    [operations.resume.name, databaseWriteHandler(operations.resume, (input) => mutate(input[0][0], () => state(input[1]).resume(...input[0])))],
    [operations.skip.name, databaseWriteHandler(operations.skip, (input) => mutate(input[0][0], () => state(input[1]).skip(...input[0])))],
    [operations.fail.name, databaseWriteHandler(operations.fail, (input) => mutate(input[0][0], () => state(input[1]).fail(...input[0])))],
    [operations.cancel.name, databaseWriteHandler(operations.cancel, (input) => mutate(input[0][0], () => state(input[1]).cancel(...input[0])))],
    [operations.markCancelled.name, databaseWriteHandler(operations.markCancelled, (input) => mutate(input[0][0], () => state(input[1]).markCancelled(...input[0])))],
    [operations.createAndBindThread.name, databaseWriteHandler(operations.createAndBindThread, (input) => {
      const previous = store.findById(input[0]);
      const result = state(input[2]).createAndBindThread(input[0], input[1]);
      return { ...result, changed: previous?.revision !== result.startup.revision };
    })],
    [operations.interruptBatch.name, databaseWriteHandler(operations.interruptBatch, (input) => state(input[1]).interruptBatch(input[0]))],
  ]);
}
