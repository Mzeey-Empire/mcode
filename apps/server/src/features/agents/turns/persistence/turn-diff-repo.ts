import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { TurnDiffStore } from "./turn-diff-store.js";
import { turnDiffWriteOperations } from "./turn-diff-write-operations.js";
export type { StoredTurnDiff } from "./turn-diff-store.js";

/** Read-only queries and committed mutations for TurnDiffRepo. */
@injectable()
export class TurnDiffRepo {
  private readonly reader: TurnDiffStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new TurnDiffStore(db);
  }

  create(record: Parameters<TurnDiffStore["create"]>[0]): Promise<ReturnType<TurnDiffStore["create"]>> {
    return this.writer.execute(turnDiffWriteOperations.create, [record]);
  }

  latest(threadId: Parameters<TurnDiffStore["latest"]>[0]): ReturnType<TurnDiffStore["latest"]> {
    return this.reader.latest(threadId);
  }

  findByMessage(threadId: Parameters<TurnDiffStore["findByMessage"]>[0], messageId: Parameters<TurnDiffStore["findByMessage"]>[1]): ReturnType<TurnDiffStore["findByMessage"]> {
    return this.reader.findByMessage(threadId, messageId);
  }

  find(threadId: Parameters<TurnDiffStore["find"]>[0], id: Parameters<TurnDiffStore["find"]>[1]): ReturnType<TurnDiffStore["find"]> {
    return this.reader.find(threadId, id);
  }

  latestLegacySnapshotId(threadId: Parameters<TurnDiffStore["latestLegacySnapshotId"]>[0]): ReturnType<TurnDiffStore["latestLegacySnapshotId"]> {
    return this.reader.latestLegacySnapshotId(threadId);
  }
}
