import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { lazySchema } from "@mcode/contracts/utils/lazySchema";
import { ScheduledTurnResumeSchema } from "@mcode/contracts/models/turn-recovery";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { turnResumeSchedules } from "../../../runtime/persistence/sqlite/schema.js";

const scheduleRowSchema = lazySchema(() => z.object({
  threadId: z.string(),
  turnId: ScheduledTurnResumeSchema().shape.turnId,
  executionId: z.string(),
  runAt: ScheduledTurnResumeSchema().shape.at,
  createdAt: z.string().datetime({ offset: true }),
}).strict());

/** Durable resume intent, including the execution that authorized it. */
export type TurnResumeScheduleRow = z.infer<ReturnType<typeof scheduleRowSchema>>;

const upsertSchedule = databaseWriteOperation("turnResumeSchedule.upsert", scheduleRowSchema(), z.void());
const deleteSchedule = databaseWriteOperation("turnResumeSchedule.delete", z.string(), z.void());

/** Allowlisted schedule mutations on the application's writable connection. */
export function turnResumeScheduleWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  return new Map([
    [upsertSchedule.name, databaseWriteHandler(upsertSchedule, (row) => {
      orm.insert(turnResumeSchedules).values(row).onConflictDoUpdate({ target: turnResumeSchedules.threadId, set: row }).run();
    })],
    [deleteSchedule.name, databaseWriteHandler(deleteSchedule, (threadId) => {
      orm.delete(turnResumeSchedules).where(eq(turnResumeSchedules.threadId, threadId)).run();
    })],
  ]);
}

/** Reads resume intents and commits their mutations through the shared writer. */
@injectable()
export class TurnResumeScheduleStore {
  private readonly orm;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.orm = drizzle(db);
  }

  /** Read a thread's pending resume, if any. */
  get(threadId: string): TurnResumeScheduleRow | null {
    const row = this.orm.select().from(turnResumeSchedules).where(eq(turnResumeSchedules.threadId, threadId)).get();
    return row ? scheduleRowSchema().parse(row) : null;
  }

  /** Restore all durable intents at startup. */
  listAll(): TurnResumeScheduleRow[] {
    return this.orm.select().from(turnResumeSchedules).all().map((row) => scheduleRowSchema().parse(row));
  }

  /** Replace the single pending resume for this thread. */
  upsert(row: TurnResumeScheduleRow): Promise<void> {
    return this.writer.execute(upsertSchedule, row);
  }

  /** Remove a pending resume; absence is already success. */
  delete(threadId: string): Promise<void> {
    return this.writer.execute(deleteSchedule, threadId);
  }
}
