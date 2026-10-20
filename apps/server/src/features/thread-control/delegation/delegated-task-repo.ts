import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { DelegatedTaskStore, type ClaimTaskInput, type ClaimResult } from "./delegated-task-store.js";
import { claimDelegatedTask } from "./delegated-task-write-operations.js";

/** Read-only receipt queries and committed claims through the application writer. */
@injectable()
export class DelegatedTaskRepo {
  private readonly reader;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new DelegatedTaskStore(db);
  }

  /** Atomically reserve a Coordinator's retry key. */
  claim(input: ClaimTaskInput): Promise<ClaimResult> { return this.writer.execute(claimDelegatedTask, [input]); }
  /** Read only tasks owned by the authenticated Coordinator. */
  find(taskId: string, coordinatorThreadId: string) { return this.reader.find(taskId, coordinatorThreadId); }
  /** Recover the immutable plan for an identical retry. */
  findByRequest(coordinatorThreadId: string, clientRequestId: string) { return this.reader.findByRequest(coordinatorThreadId, clientRequestId); }
  /** Read by identity for trusted human approval recovery. */
  get(taskId: string) { return this.reader.get(taskId); }
}
