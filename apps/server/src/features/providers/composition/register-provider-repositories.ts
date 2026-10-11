import { Lifecycle, type DependencyContainer } from "tsyringe";

import { ModelCacheRepo } from "../models/persistence/model-cache-repo.js";
import { ModelSightingsRepo } from "../status/model-sightings-repo.js";
import { ProviderCatalogSnapshotRepo } from "../catalog/persistence/provider-catalog-snapshot-repo.js";

/** Register provider-owned persistence repositories in application order. */
export function registerProviderRepositories(container: DependencyContainer): void {
  container.register(ModelSightingsRepo, { useClass: ModelSightingsRepo }, { lifecycle: Lifecycle.Singleton });
  container.register(
    ModelCacheRepo,
    { useClass: ModelCacheRepo },
    { lifecycle: Lifecycle.Singleton },
  );
}

/** Register the provider catalog snapshot repository after pull-request persistence. */
export function registerProviderCatalogRepository(container: DependencyContainer): void {
  container.register(
    ProviderCatalogSnapshotRepo,
    { useClass: ProviderCatalogSnapshotRepo },
    { lifecycle: Lifecycle.Singleton },
  );
}
