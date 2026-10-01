import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { TurnSnapshotStore } from "./turn-snapshot-store.js";
import { turnSnapshotWriteOperations } from "./turn-snapshot-write-operations.js";
export type { CreateTurnSnapshotInput } from "./turn-snapshot-store.js";

/** Read-only queries and committed mutations for TurnSnapshotRepo. */
@injectable()
export class TurnSnapshotRepo {
  private readonly reader: TurnSnapshotStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new TurnSnapshotStore(db);
  }

  create(input: Parameters<TurnSnapshotStore["create"]>[0]): Promise<ReturnType<TurnSnapshotStore["create"]>> {
    return this.writer.execute(turnSnapshotWriteOperations.create, [input]);
  }

  getById(id: Parameters<TurnSnapshotStore["getById"]>[0]): ReturnType<TurnSnapshotStore["getById"]> {
    return this.reader.getById(id);
  }

  getByMessage(messageId: Parameters<TurnSnapshotStore["getByMessage"]>[0]): ReturnType<TurnSnapshotStore["getByMessage"]> {
    return this.reader.getByMessage(messageId);
  }

  listByThread(threadId: Parameters<TurnSnapshotStore["listByThread"]>[0]): ReturnType<TurnSnapshotStore["listByThread"]> {
    return this.reader.listByThread(threadId);
  }

  deleteExpired(maxAgeDays: Parameters<TurnSnapshotStore["deleteExpired"]>[0]): Promise<ReturnType<TurnSnapshotStore["deleteExpired"]>> {
    return this.writer.execute(turnSnapshotWriteOperations.deleteExpired, [maxAgeDays]);
  }
}
