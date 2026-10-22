import type { Thread } from "@mcode/contracts";

/** The thread itself and, for a delegated thread, its parent Coordinator: a nested Coordinator is both. */
export function wakeTargets(thread: Pick<Thread, "id" | "delegation_coordinator_thread_id">): string[] {
  const parent = thread.delegation_coordinator_thread_id;
  return parent ? [thread.id, parent] : [thread.id];
}
