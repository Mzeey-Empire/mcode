import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import type {
  CommitRequestRecord,
  CommitSettlement,
  FinishedCommitPush,
  PreparedCommitRequestInput,
} from "../commit-request.js";
import { GitCommitRequestStore } from "./git-commit-request-store.js";
import { gitCommitRequestWriteOperations as operations } from "./git-commit-request-write-operations.js";

/** Reads commit requests directly and commits every write through the database writer before returning. */
@injectable()
export class GitCommitRequestRepo {
  private readonly reader: GitCommitRequestStore;

  constructor(
    @inject("Database") db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
  ) {
    this.reader = new GitCommitRequestStore(db);
  }

  /** Read one request by its client id. */
  findById(requestId: string): CommitRequestRecord | null {
    return this.reader.findById(requestId);
  }

  /** Every request no process has settled. */
  listPrepared(): CommitRequestRecord[] {
    return this.reader.listPrepared();
  }

  /** Durably record a request before git runs, so a crash leaves a row to reconcile. */
  insertPrepared(input: PreparedCommitRequestInput): Promise<void> {
    return this.writer.execute(operations.insertPrepared, [input]);
  }

  /** Settle a prepared request. Resolves false when it was already settled. */
  settle(requestId: string, settlement: CommitSettlement): Promise<boolean> {
    return this.writer.execute(operations.settle, [requestId, settlement]);
  }

  /** Record a finished push on a committed request. */
  recordPush(requestId: string, push: FinishedCommitPush): Promise<boolean> {
    return this.writer.execute(operations.recordPush, [requestId, push]);
  }

  /** Delete requests prepared more than `maxAgeDays` ago. */
  deleteExpired(maxAgeDays: number): Promise<number> {
    return this.writer.execute(operations.deleteExpired, [maxAgeDays]);
  }
}
