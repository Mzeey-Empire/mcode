import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkspaceEnvironmentConfigurationStore } from "./workspace-environment-configuration-store.js";
import { workspaceEnvironmentConfigurationWriteOperations } from "./workspace-environment-configuration-write-operations.js";

/** Read-only queries and committed mutations for WorkspaceEnvironmentConfigurationRepo. */
@injectable()
export class WorkspaceEnvironmentConfigurationRepo {
  private readonly reader: WorkspaceEnvironmentConfigurationStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new WorkspaceEnvironmentConfigurationStore(db);
  }

  storageMode(workspaceId: Parameters<WorkspaceEnvironmentConfigurationStore["storageMode"]>[0]): ReturnType<WorkspaceEnvironmentConfigurationStore["storageMode"]> {
    return this.reader.storageMode(workspaceId);
  }

  setStorageMode(workspaceId: Parameters<WorkspaceEnvironmentConfigurationStore["setStorageMode"]>[0], storageMode: Parameters<WorkspaceEnvironmentConfigurationStore["setStorageMode"]>[1]): Promise<ReturnType<WorkspaceEnvironmentConfigurationStore["setStorageMode"]>> {
    return this.writer.execute(workspaceEnvironmentConfigurationWriteOperations.setStorageMode, [workspaceId, storageMode]);
  }

  hasApproval(workspaceId: Parameters<WorkspaceEnvironmentConfigurationStore["hasApproval"]>[0], commandId: Parameters<WorkspaceEnvironmentConfigurationStore["hasApproval"]>[1], fingerprint: Parameters<WorkspaceEnvironmentConfigurationStore["hasApproval"]>[2]): ReturnType<WorkspaceEnvironmentConfigurationStore["hasApproval"]> {
    return this.reader.hasApproval(workspaceId, commandId, fingerprint);
  }

  /** Returns command identities with a persisted approval, including stale approvals. */
  listApprovedCommandIds(workspaceId: string): string[] {
    return this.reader.listApprovedCommandIds(workspaceId);
  }

  /** Commits removal of only one command's approval. */
  forgetApproval(workspaceId: string, commandId: string): Promise<void> {
    return this.writer.execute(workspaceEnvironmentConfigurationWriteOperations.forgetApproval, [workspaceId, commandId]);
  }

  approve(workspaceId: Parameters<WorkspaceEnvironmentConfigurationStore["approve"]>[0], commandId: Parameters<WorkspaceEnvironmentConfigurationStore["approve"]>[1], fingerprint: Parameters<WorkspaceEnvironmentConfigurationStore["approve"]>[2]): Promise<ReturnType<WorkspaceEnvironmentConfigurationStore["approve"]>> {
    return this.writer.execute(workspaceEnvironmentConfigurationWriteOperations.approve, [workspaceId, commandId, fingerprint]);
  }

  /** Removes all stored command approvals during Project deletion. */
  removeWorkspaceApprovals(workspaceId: Parameters<WorkspaceEnvironmentConfigurationStore["removeWorkspaceApprovals"]>[0]): Promise<ReturnType<WorkspaceEnvironmentConfigurationStore["removeWorkspaceApprovals"]>> {
    return this.writer.execute(workspaceEnvironmentConfigurationWriteOperations.removeWorkspaceApprovals, [workspaceId]);
  }
}
