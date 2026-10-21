import type { Thread } from "@mcode/contracts";

/**
 * The Coordinators a change on this thread can affect. The thread's own routing changed, and its parent
 * Coordinator's task state changed; a nested Coordinator is both, so it needs both nudges.
 */
export function wakeTargets(thread: Pick<Thread, "id" | "delegation_coordinator_thread_id">): string[] {
  const parent = thread.delegation_coordinator_thread_id;
  return parent ? [thread.id, parent] : [thread.id];
}
