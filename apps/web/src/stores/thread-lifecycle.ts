import type { AgentTurn, TurnRuntimePhase } from "@mcode/contracts";
import type { ThreadRecord } from "./thread-record";

/** Selects the provider-owned child lifecycle when no local execution owns the thread. */
export function getCanonicalLifecycleTurn(threadId: string, record: ThreadRecord): AgentTurn | undefined {
  if (record.turnExecutionId !== null || record.runtimePhase !== "idle") return undefined;
  const latest = Object.values(record.canonicalAgent.state.turns)
    .filter((turn) => turn.threadId === threadId)
    .sort((left, right) => Date.parse(left.startedAt ?? left.createdAt)
      - Date.parse(right.startedAt ?? right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  return latest?.trigger.kind === "child" ? latest : undefined;
}

/** Resolves the lifecycle shared by transcript, Composer, and running-thread indicators. */
export function getThreadRuntimePhase(threadId: string, record: ThreadRecord): TurnRuntimePhase {
  const turn = getCanonicalLifecycleTurn(threadId, record);
  if (!turn) return record.runtimePhase;
  switch (turn.status) {
    case "Pending":
    case "Running": return "running";
    case "Completed": return "completed";
    case "Cancelled": return "cancelled";
    case "Interrupted": return "interrupted";
    case "Errored": return "errored";
  }
}

/** Whether the current lifecycle still owns execution, including final persistence. */
export function isThreadRuntimeActive(threadId: string, record: ThreadRecord): boolean {
  const phase = getThreadRuntimePhase(threadId, record);
  return phase === "running" || phase === "finalizing";
}
