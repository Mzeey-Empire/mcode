import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ModelSightingsStore } from "./model-sightings-store.js";
import { modelSightingsWriteOperations } from "./model-sightings-write-operations.js";

/** Read-only sightings and committed mutations, notifying subscribers only after changes commit. */
@injectable()
export class ModelSightingsRepo {
  private readonly reader: ModelSightingsStore;
  private readonly listeners = new Set<(providerId: ProviderId) => void>();

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ModelSightingsStore(db);
  }

  /** Returns unacknowledged sightings in newest-first order. */
  listOpen(providerId: ProviderId): ReturnType<ModelSightingsStore["listOpen"]> {
    return this.reader.listOpen(providerId);
  }

  /** Records a successful nonempty catalog without reopening acknowledged models. */
  async record(providerId: ProviderId, modelIds: string[], now: string): Promise<void> {
    if (modelIds.length === 0) return;
    if (await this.writer.execute(modelSightingsWriteOperations.record, [providerId, modelIds, now])) this.emit(providerId);
  }

  /** Acknowledges every open announcement for this provider. */
  async acknowledge(providerId: ProviderId, now: string): Promise<void> {
    if (await this.writer.execute(modelSightingsWriteOperations.acknowledge, [providerId, now])) this.emit(providerId);
  }

  /** Subscribes to committed changes; returns an unsubscribe function. */
  onChange(listener: (providerId: ProviderId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(providerId: ProviderId): void {
    for (const listener of this.listeners) listener(providerId);
  }
}
