import { SHUTDOWN_PERSISTENCE_START_MS } from "@mcode/shared/node/shutdown-deadlines";

/** Server shutdown in two halves: stopping services, then saving accepted turn output. */
export interface ShutdownPhases {
  /** Stops agents, providers, terminals, and the other services. Any of them may hang. */
  stopServices(): Promise<void>;
  /** Writes accepted turn output to SQLite and closes the databases. */
  persist(): Promise<void>;
  /** Reports which service phase was still running when persistence had to start. */
  onServicesOverrun(): void;
}

/**
 * Runs `persist` once `stopServices` finishes, or `SHUTDOWN_PERSISTENCE_START_MS` after this call, whichever
 * comes first. The watchdog exits at `SERVER_SHUTDOWN_DEADLINE_MS`, so no hung service can spend the time
 * persistence needs. A service still running then is left to the process exit. A service failure is rethrown
 * after persistence, so it cannot skip the save either.
 */
export async function runShutdownPhases(phases: ShutdownPhases): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persistenceDue = new Promise<"overrun">((resolve) => {
    timer = setTimeout(() => resolve("overrun"), SHUTDOWN_PERSISTENCE_START_MS);
  });
  const services = phases.stopServices().then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  );
  const stopped = await Promise.race([services, persistenceDue]);
  clearTimeout(timer);
  if (stopped === "overrun") phases.onServicesOverrun();
  await phases.persist();
  if (stopped !== "overrun" && stopped.failed) throw stopped.error;
}
