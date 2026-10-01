import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkspaceTerminalPreferencesStore } from "./workspace-terminal-preferences-store.js";
import { workspaceTerminalPreferencesWriteOperations } from "./workspace-terminal-preferences-write-operations.js";
export { TerminalWorkspaceNotFoundError } from "./workspace-terminal-preferences-store.js";

/** Read-only queries and committed mutations for WorkspaceTerminalPreferencesService. */
@injectable()
export class WorkspaceTerminalPreferencesService {
  private readonly reader: WorkspaceTerminalPreferencesStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new WorkspaceTerminalPreferencesStore(db);
  }

  get(workspaceId: Parameters<WorkspaceTerminalPreferencesStore["get"]>[0]): ReturnType<WorkspaceTerminalPreferencesStore["get"]> {
    return this.reader.get(workspaceId);
  }

  update(workspaceId: Parameters<WorkspaceTerminalPreferencesStore["update"]>[0], defaultProfileId: Parameters<WorkspaceTerminalPreferencesStore["update"]>[1]): Promise<ReturnType<WorkspaceTerminalPreferencesStore["update"]>> {
    return this.writer.execute(workspaceTerminalPreferencesWriteOperations.update, [workspaceId, defaultProfileId]);
  }

  reset(workspaceId: Parameters<WorkspaceTerminalPreferencesStore["reset"]>[0]): Promise<ReturnType<WorkspaceTerminalPreferencesStore["reset"]>> {
    return this.writer.execute(workspaceTerminalPreferencesWriteOperations.reset, [workspaceId]);
  }

  listReferences(profileId: Parameters<WorkspaceTerminalPreferencesStore["listReferences"]>[0]): ReturnType<WorkspaceTerminalPreferencesStore["listReferences"]> {
    return this.reader.listReferences(profileId);
  }
}
