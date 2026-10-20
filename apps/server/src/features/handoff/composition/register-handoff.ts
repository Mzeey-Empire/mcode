import { Lifecycle, type DependencyContainer } from "tsyringe";

import {
  HandoffCheckoutService,
  HandoffStorage,
} from "../index.js";

/** Register handoff storage and checkout services. */
export function registerHandoffServices(container: DependencyContainer): void {
  container.register(
    HandoffStorage,
    { useClass: HandoffStorage },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffCheckoutService,
    { useClass: HandoffCheckoutService },
    { lifecycle: Lifecycle.Singleton },
  );
}
