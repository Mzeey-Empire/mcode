import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { lazySchema, ScheduledTurnRetrySchema } from "@mcode/contracts";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { turnRetrySchedules } from "../../../runtime/persistence/sqlite/schema.js";

const scheduleRowSchema = lazySchema(() => z.object({
  threadId: z.string(),
  turnId: ScheduledTurnRetrySchema().shape.turnId,
  executionId: z.string(),
  runAt: ScheduledTurnRetrySchema().shape.at,
  createdAt: z.string().datetime({ offset: true }),
}).strict());

/** Durable retry intent, including the execution that authorized it. */
export type TurnRetryScheduleRow = z.infer<ReturnType<typeof scheduleRowSchema>>;

const upsertSchedule = databaseWriteOperation("turnRetrySchedule.upsert", scheduleRowSchema(), z.void());
const deleteSchedule = databaseWriteOperation("turnRetrySchedule.delete", z.string(), z.void());

/** Allowlisted schedule mutations on the application's writable connection. */
export function turnRetryScheduleWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  return new Map([
    [upsertSchedule.name, databaseWriteHandler(upsertSchedule, (row) => {
      orm.insert(turnRetrySchedules).values(row).onConflictDoUpdate({ target: turnRetrySchedules.threadId, set: row }).run();
    })],
    [deleteSchedule.name, databaseWriteHandler(deleteSchedule, (threadId) => {
      orm.delete(turnRetrySchedules).where(eq(turnRetrySchedules.threadId, threadId)).run();
    })],
  ]);
}

/** Reads retry intents and commits their mutations through the shared writer. */
@injectable()
export class TurnRetryScheduleStore {
  private readonly orm;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.orm = drizzle(db);
  }

  /** Read a thread's pending retry, if any. */
  get(threadId: string): TurnRetryScheduleRow | null {
    const row = this.orm.select().from(turnRetrySchedules).where(eq(turnRetrySchedules.threadId, threadId)).get();
    return row ? scheduleRowSchema().parse(row) : null;
  }

  /** Restore all durable intents at startup. */
  listAll(): TurnRetryScheduleRow[] {
    return this.orm.select().from(turnRetrySchedules).all().map((row) => scheduleRowSchema().parse(row));
  }

  /** Replace the single pending retry for this thread. */
  upsert(row: TurnRetryScheduleRow): Promise<void> {
    return this.writer.execute(upsertSchedule, row);
  }

  /** Remove a pending retry; absence is already success. */
  delete(threadId: string): Promise<void> {
    return this.writer.execute(deleteSchedule, threadId);
  }
}
