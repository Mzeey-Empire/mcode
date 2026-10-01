import { MessageSchema, type AgentTurn, type AgentTurnStatus, type TurnRuntimePhase } from "@mcode/contracts";
import type { ThreadRecord } from "./thread-record";

function latestCanonicalTurn(threadId: string, record: ThreadRecord): AgentTurn | undefined {
  return Object.values(record.canonicalAgent.state.turns)
    .filter((turn) => turn.threadId === threadId)
    .sort((left, right) => Date.parse(left.startedAt ?? left.createdAt)
      - Date.parse(right.startedAt ?? right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
}

function admitsOptimisticPrompt(threadId: string, turn: AgentTurn, record: ThreadRecord): boolean {
  if (!record.optimisticUserMessageId || !turn.executionId || turn.trigger.kind !== "user") return false;
  return Object.values(record.canonicalAgent.state.items).some((item) => {
    if (item.threadId !== threadId || item.turnId !== turn.id || item.payload.projection !== "message") return false;
    const message = MessageSchema().safeParse(item.payload.message);
    return message.success && message.data.role === "user" && message.data.thread_id === threadId
      && message.data.id === record.optimisticUserMessageId;
  });
}

/** Selects the provider-owned child lifecycle when no local execution is active. */
export function getCanonicalLifecycleTurn(threadId: string, record: ThreadRecord): AgentTurn | undefined {
  const latest = latestCanonicalTurn(threadId, record);
  if (latest?.trigger.kind !== "child") return undefined;
  // A runtime phase stamped by this same canonical turn must not gate it out;
  // only a locally-owned phase suppresses the child lifecycle.
  const locallyOwnedPhase = getCanonicalRuntimeTurn(threadId, record)?.id === latest.id
    ? "idle"
    : record.runtimePhase;
  if (locallyOwnedPhase === "running" || locallyOwnedPhase === "finalizing") return undefined;
  if (locallyOwnedPhase !== "idle" && (latest.status === "Pending" || latest.status === "Running")) return undefined;
  return latest;
}

/**
 * Canonical turn that owns this record's runtime phase, once correlation is
 * proven. A tracked local execution only follows the canonical turn carrying
 * the same execution identity, so an older persisted turn cannot clear or
 * resurrect a live run while a matching terminal can clear a stale one.
 */
export function getCanonicalRuntimeTurn(threadId: string, record: ThreadRecord): AgentTurn | undefined {
  if (record.runtimePhase === "finalizing") return undefined;
  const latest = latestCanonicalTurn(threadId, record);
  if (!latest) return undefined;
  if (record.turnExecutionId !== null) {
    return latest.executionId === record.turnExecutionId ? latest : undefined;
  }
  // Saved admission does not replay turnStarted. Only this exact prompt can
  // claim an optimistic run; an older recovery must not cancel a newer send.
  if (record.runtimePhase === "running") return admitsOptimisticPrompt(threadId, latest, record) ? latest : undefined;
  // Without an identity, canonical Pending or Running claims only idle
  // records; terminal truth may claim any non-busy record.
  if ((latest.status === "Pending" || latest.status === "Running") && record.runtimePhase !== "idle") return undefined;
  return latest;
}

/** Runtime phase equivalent of one canonical turn status. */
export function phaseForTurnStatus(status: AgentTurnStatus): TurnRuntimePhase {
  switch (status) {
    case "Pending":
    case "Running": return "running";
    case "Completed": return "completed";
    case "Cancelled": return "cancelled";
    case "Interrupted": return "interrupted";
    case "Errored": return "errored";
  }
}

/** Canonical-owned runtime phase for this record, or null when legacy owns it. */
export function getCanonicalRuntimePhase(threadId: string, record: ThreadRecord): TurnRuntimePhase | null {
  const turn = getCanonicalRuntimeTurn(threadId, record);
  return turn ? phaseForTurnStatus(turn.status) : null;
}

/** Resolves the lifecycle shared by transcript, Composer, and running-thread indicators. */
export function getThreadRuntimePhase(threadId: string, record: ThreadRecord): TurnRuntimePhase {
  return getCanonicalRuntimePhase(threadId, record) ?? record.runtimePhase;
}

/** Whether the current lifecycle still owns execution, including final persistence. */
export function isThreadRuntimeActive(threadId: string, record: ThreadRecord): boolean {
  const phase = getThreadRuntimePhase(threadId, record);
  return phase === "running" || phase === "finalizing";
}
