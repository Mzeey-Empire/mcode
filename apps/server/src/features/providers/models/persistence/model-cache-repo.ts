import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { ModelCacheStore } from "./model-cache-store.js";
import { modelCacheWriteOperations } from "./model-cache-write-operations.js";
export type { CachedModelEntry } from "./model-cache-store.js";

/** Read-only queries and committed mutations for ModelCacheRepo. */
@injectable()
export class ModelCacheRepo {
  private readonly reader: ModelCacheStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ModelCacheStore(db);
  }

  get(providerId: Parameters<ModelCacheStore["get"]>[0]): ReturnType<ModelCacheStore["get"]> {
    return this.reader.get(providerId);
  }

  getAll(): ReturnType<ModelCacheStore["getAll"]> {
    return this.reader.getAll();
  }

  upsert(providerId: Parameters<ModelCacheStore["upsert"]>[0], models: Parameters<ModelCacheStore["upsert"]>[1]): Promise<ReturnType<ModelCacheStore["upsert"]>> {
    return this.writer.execute(modelCacheWriteOperations.upsert, [providerId, models]);
  }

  delete(providerId: Parameters<ModelCacheStore["delete"]>[0]): Promise<ReturnType<ModelCacheStore["delete"]>> {
    return this.writer.execute(modelCacheWriteOperations.delete, [providerId]);
  }
}
