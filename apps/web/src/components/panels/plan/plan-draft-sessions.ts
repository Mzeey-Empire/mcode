import { getTransport } from "@/transport";
import { usePlanStore } from "@/stores/planStore";
import { PlanSaveScheduler } from "./plan-save-scheduler";

// Module scope, not component state: unacknowledged text and a held conflict
// must survive closing the panel and switching threads.
const schedulers = new Map<string, PlanSaveScheduler>();

/** The thread's plan save scheduler, created on first use and kept for the session. */
export function planSaveScheduler(threadId: string): PlanSaveScheduler {
  const existing = schedulers.get(threadId);
  if (existing) return existing;
  const scheduler = new PlanSaveScheduler(threadId, {
    save: (payload) => getTransport().savePlanVersion(payload),
    onVersion: (version) => usePlanStore.getState().addPlan(threadId, version),
    newId: () => crypto.randomUUID(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  });
  schedulers.set(threadId, scheduler);
  return scheduler;
}
