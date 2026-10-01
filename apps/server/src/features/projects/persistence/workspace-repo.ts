import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkspaceStore } from "./workspace-store.js";
import { workspaceWriteOperations } from "./workspace-write-operations.js";

/** Read-only queries and committed mutations for WorkspaceRepo. */
@injectable()
export class WorkspaceRepo {
  private readonly reader: WorkspaceStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new WorkspaceStore(db);
  }

  create(name: Parameters<WorkspaceStore["create"]>[0], path: Parameters<WorkspaceStore["create"]>[1], isGitRepo: Parameters<WorkspaceStore["create"]>[2] = true): Promise<ReturnType<WorkspaceStore["create"]>> {
    return this.writer.execute(workspaceWriteOperations.create, [name, path, isGitRepo]);
  }

  prependToSortOrder(id: Parameters<WorkspaceStore["prependToSortOrder"]>[0]): Promise<ReturnType<WorkspaceStore["prependToSortOrder"]>> {
    return this.writer.execute(workspaceWriteOperations.prependToSortOrder, [id]);
  }

  reorderToIndex(id: Parameters<WorkspaceStore["reorderToIndex"]>[0], newIndex: Parameters<WorkspaceStore["reorderToIndex"]>[1]): Promise<ReturnType<WorkspaceStore["reorderToIndex"]>> {
    return this.writer.execute(workspaceWriteOperations.reorderToIndex, [id, newIndex]);
  }

  findById(id: Parameters<WorkspaceStore["findById"]>[0]): ReturnType<WorkspaceStore["findById"]> {
    return this.reader.findById(id);
  }

  findByPath(path: Parameters<WorkspaceStore["findByPath"]>[0]): ReturnType<WorkspaceStore["findByPath"]> {
    return this.reader.findByPath(path);
  }

  listAll(): ReturnType<WorkspaceStore["listAll"]> {
    return this.reader.listAll();
  }

  search(query: Parameters<WorkspaceStore["search"]>[0], limit: Parameters<WorkspaceStore["search"]>[1]): ReturnType<WorkspaceStore["search"]> {
    return this.reader.search(query, limit);
  }

  rename(id: Parameters<WorkspaceStore["rename"]>[0], name: Parameters<WorkspaceStore["rename"]>[1]): Promise<ReturnType<WorkspaceStore["rename"]>> {
    return this.writer.execute(workspaceWriteOperations.rename, [id, name]);
  }

  setPinned(id: Parameters<WorkspaceStore["setPinned"]>[0], pinned: Parameters<WorkspaceStore["setPinned"]>[1]): Promise<ReturnType<WorkspaceStore["setPinned"]>> {
    return this.writer.execute(workspaceWriteOperations.setPinned, [id, pinned]);
  }

  touchLastOpened(id: Parameters<WorkspaceStore["touchLastOpened"]>[0]): Promise<ReturnType<WorkspaceStore["touchLastOpened"]>> {
    return this.writer.execute(workspaceWriteOperations.touchLastOpened, [id]);
  }

  removeRecent(id: Parameters<WorkspaceStore["removeRecent"]>[0]): Promise<ReturnType<WorkspaceStore["removeRecent"]>> {
    return this.writer.execute(workspaceWriteOperations.removeRecent, [id]);
  }

  softDelete(id: Parameters<WorkspaceStore["softDelete"]>[0]): Promise<ReturnType<WorkspaceStore["softDelete"]>> {
    return this.writer.execute(workspaceWriteOperations.softDelete, [id]);
  }

  hardDelete(id: Parameters<WorkspaceStore["hardDelete"]>[0]): Promise<ReturnType<WorkspaceStore["hardDelete"]>> {
    return this.writer.execute(workspaceWriteOperations.hardDelete, [id]);
  }

  findDeleting(): ReturnType<WorkspaceStore["findDeleting"]> {
    return this.reader.findDeleting();
  }

  findDeletingByPath(path: Parameters<WorkspaceStore["findDeletingByPath"]>[0]): ReturnType<WorkspaceStore["findDeletingByPath"]> {
    return this.reader.findDeletingByPath(path);
  }

  findByIdIncludeDeleted(id: Parameters<WorkspaceStore["findByIdIncludeDeleted"]>[0]): ReturnType<WorkspaceStore["findByIdIncludeDeleted"]> {
    return this.reader.findByIdIncludeDeleted(id);
  }

  touch(id: Parameters<WorkspaceStore["touch"]>[0]): Promise<ReturnType<WorkspaceStore["touch"]>> {
    return this.writer.execute(workspaceWriteOperations.touch, [id]);
  }

  setIsGitRepo(id: Parameters<WorkspaceStore["setIsGitRepo"]>[0], isGitRepo: Parameters<WorkspaceStore["setIsGitRepo"]>[1]): Promise<ReturnType<WorkspaceStore["setIsGitRepo"]>> {
    return this.writer.execute(workspaceWriteOperations.setIsGitRepo, [id, isGitRepo]);
  }
}
