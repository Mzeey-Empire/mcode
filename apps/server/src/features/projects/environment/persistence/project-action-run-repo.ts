import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ProjectActionRunStore } from "./project-action-run-store.js";
import { projectActionRunWriteOperations } from "./project-action-run-write-operations.js";

/** Read-only queries and committed mutations for ProjectActionRunRepo. */
@injectable()
export class ProjectActionRunRepo {
  private readonly reader: ProjectActionRunStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ProjectActionRunStore(db);
  }

  get(threadId: Parameters<ProjectActionRunStore["get"]>[0], actionId: Parameters<ProjectActionRunStore["get"]>[1]): ReturnType<ProjectActionRunStore["get"]> {
    return this.reader.get(threadId, actionId);
  }

  list(threadId: Parameters<ProjectActionRunStore["list"]>[0]): ReturnType<ProjectActionRunStore["list"]> {
    return this.reader.list(threadId);
  }

  replace(run: Parameters<ProjectActionRunStore["replace"]>[0]): Promise<ReturnType<ProjectActionRunStore["replace"]>> {
    return this.writer.execute(projectActionRunWriteOperations.replace, [run]);
  }

  updateIfCurrent(run: Parameters<ProjectActionRunStore["updateIfCurrent"]>[0]): Promise<ReturnType<ProjectActionRunStore["updateIfCurrent"]>> {
    return this.writer.execute(projectActionRunWriteOperations.updateIfCurrent, [run]);
  }

  interruptRunning(finishedAt: Parameters<ProjectActionRunStore["interruptRunning"]>[0]): Promise<ReturnType<ProjectActionRunStore["interruptRunning"]>> {
    return this.writer.execute(projectActionRunWriteOperations.interruptRunning, [finishedAt]);
  }
}
