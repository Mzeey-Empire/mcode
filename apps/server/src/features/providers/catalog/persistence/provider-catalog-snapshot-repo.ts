import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ProviderCatalogSnapshotStore } from "./provider-catalog-snapshot-store.js";
import { providerCatalogSnapshotWriteOperations } from "./provider-catalog-snapshot-write-operations.js";

/** Read-only queries and committed mutations for ProviderCatalogSnapshotRepo. */
@injectable()
export class ProviderCatalogSnapshotRepo {
  private readonly reader: ProviderCatalogSnapshotStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ProviderCatalogSnapshotStore(db);
  }

  get(contextKey: Parameters<ProviderCatalogSnapshotStore["get"]>[0]): ReturnType<ProviderCatalogSnapshotStore["get"]> {
    return this.reader.get(contextKey);
  }

  upsert(contextKey: Parameters<ProviderCatalogSnapshotStore["upsert"]>[0], workspaceId: Parameters<ProviderCatalogSnapshotStore["upsert"]>[1], cwd: Parameters<ProviderCatalogSnapshotStore["upsert"]>[2], snapshot: Parameters<ProviderCatalogSnapshotStore["upsert"]>[3]): Promise<ReturnType<ProviderCatalogSnapshotStore["upsert"]>> {
    return this.writer.execute(providerCatalogSnapshotWriteOperations.upsert, [contextKey, workspaceId, cwd, snapshot]);
  }
}
