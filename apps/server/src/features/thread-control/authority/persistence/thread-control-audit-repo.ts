import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { threadControlAudit } from "../../../../runtime/persistence/sqlite/schema.js";

/** Writes bounded, content-free thread-control audit events. */
@injectable()
export class ThreadControlAuditRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Persist one operation outcome without prompt, credential, or path data. */
  write(input: { callerId: string; sourceThreadId?: string; workspaceId?: string; threadId?: string; operation: string; outcome: string }): void {
    this.orm.insert(threadControlAudit).values({
      id: NodeCrypto.randomUUID(),
      callerId: input.callerId,
      sourceThreadId: input.sourceThreadId ?? null,
      workspaceId: input.workspaceId ?? null,
      threadId: input.threadId ?? null,
      operation: input.operation,
      outcome: input.outcome,
    }).run();
  }
}
