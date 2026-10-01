import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { TaskStore } from "./task-store.js";
import { taskWriteOperations } from "./task-write-operations.js";
export type { StoredTask } from "./task-store.js";

/** Read-only queries and committed mutations for TaskRepo. */
@injectable()
export class TaskRepo {
  private readonly reader: TaskStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new TaskStore(db);
  }

  upsert(threadId: Parameters<TaskStore["upsert"]>[0], tasks: Parameters<TaskStore["upsert"]>[1]): Promise<ReturnType<TaskStore["upsert"]>> {
    return this.writer.execute(taskWriteOperations.upsert, [threadId, tasks]);
  }

  upsertGroup(threadId: Parameters<TaskStore["upsertGroup"]>[0], group: Parameters<TaskStore["upsertGroup"]>[1], tasks: Parameters<TaskStore["upsertGroup"]>[2]): Promise<ReturnType<TaskStore["upsertGroup"]>> {
    return this.writer.execute(taskWriteOperations.upsertGroup, [threadId, group, tasks]);
  }

  appendTask(threadId: Parameters<TaskStore["appendTask"]>[0], task: Parameters<TaskStore["appendTask"]>[1]): Promise<ReturnType<TaskStore["appendTask"]>> {
    return this.writer.execute(taskWriteOperations.appendTask, [threadId, task]);
  }

  updateTask(threadId: Parameters<TaskStore["updateTask"]>[0], id: Parameters<TaskStore["updateTask"]>[1], patch: Parameters<TaskStore["updateTask"]>[2], group?: Parameters<TaskStore["updateTask"]>[3]): Promise<ReturnType<TaskStore["updateTask"]>> {
    return this.writer.execute(taskWriteOperations.updateTask, [threadId, id, patch, group]);
  }

  removeTask(threadId: Parameters<TaskStore["removeTask"]>[0], id: Parameters<TaskStore["removeTask"]>[1], group?: Parameters<TaskStore["removeTask"]>[2]): Promise<ReturnType<TaskStore["removeTask"]>> {
    return this.writer.execute(taskWriteOperations.removeTask, [threadId, id, group]);
  }

  get(threadId: Parameters<TaskStore["get"]>[0]): ReturnType<TaskStore["get"]> {
    return this.reader.get(threadId);
  }

  delete(threadId: Parameters<TaskStore["delete"]>[0]): Promise<ReturnType<TaskStore["delete"]>> {
    return this.writer.execute(taskWriteOperations.delete, [threadId]);
  }
}
