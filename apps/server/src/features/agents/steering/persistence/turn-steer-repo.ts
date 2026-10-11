import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import type { PendingTurnSteerInput, TurnSteerRecord, TurnSteerSettlement } from "../turn-steer.js";
import { TurnSteerStore } from "./turn-steer-store.js";
import { turnSteerWriteOperations as operations } from "./turn-steer-write-operations.js";

/** Reads steers directly and commits every write through the database writer before returning. */
@injectable()
export class TurnSteerRepo {
  private readonly reader: TurnSteerStore;

  constructor(
    @inject("Database") db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
  ) {
    this.reader = new TurnSteerStore(db);
  }

  /** Read one steer by its client message id. */
  find(messageId: string): TurnSteerRecord | null {
    return this.reader.find(messageId);
  }

  /** Whether a Send again minted this id for a resend. */
  isReplacementId(messageId: string): boolean {
    return this.reader.isReplacementId(messageId);
  }

  /** Held steers, oldest first. */
  listHeld(limit: number): TurnSteerRecord[] {
    return this.reader.listHeld(limit);
  }

  /** Durably record a steer before the adapter call, so a crash leaves a row to reconcile. */
  insertPending(input: PendingTurnSteerInput): Promise<void> {
    return this.writer.execute(operations.insertPending, [input]);
  }

  /** Settle a pending steer. Resolves false when it was no longer pending. */
  settle(messageId: string, settlement: TurnSteerSettlement): Promise<boolean> {
    return this.writer.execute(operations.settle, [messageId, settlement]);
  }

  /** Mark a pending steer delivered without a transcript message. Production delivery uses the canonical writer. */
  markDelivered(messageId: string): Promise<boolean> {
    return this.writer.execute(operations.markDelivered, [messageId]);
  }

  /** Store a Send again resend. Resolves false when the steer was not delivery_unknown. */
  requeue(messageId: string, replacementMessageId: string): Promise<boolean> {
    return this.writer.execute(operations.requeue, [messageId, replacementMessageId]);
  }

  /** Remove a held steer. Resolves false when another window settled it first. */
  remove(messageId: string): Promise<boolean> {
    return this.writer.execute(operations.remove, [messageId]);
  }

  /** Turn every pending steer a previous process left into delivery_unknown. */
  markPendingUnknown(): Promise<number> {
    return this.writer.execute(operations.markPendingUnknown, []);
  }

  /** Delete settled steers older than the retention window. */
  deleteSettledOlderThan(maxAgeDays: number): Promise<number> {
    return this.writer.execute(operations.deleteSettledOlderThan, [maxAgeDays]);
  }
}
