import type { AgentStopResult, TurnRuntimeSnapshot } from "@mcode/contracts/models/turn-runtime";

/** Return whether an event still belongs to a runtime that can change state. */
export function isActiveRuntimeExecution(
  runtime: TurnRuntimeSnapshot | null,
  executionId: string | undefined,
): boolean {
  const phase = runtime?.phase;
  return runtime?.turnExecutionId === executionId
    && (phase === "running" || phase === "finalizing");
}

/** Create the empty runtime shape used when no runtime exists for a thread. */
export function idleRuntime(threadId: string): TurnRuntimeSnapshot {
  return { threadId, turnExecutionId: null, phase: "idle" };
}

/** Return whether a runtime can still be stopped or terminalized. */
export function isRunningRuntime(runtime: TurnRuntimeSnapshot): boolean {
  return runtime.turnExecutionId !== null && (runtime.phase === "running" || runtime.phase === "finalizing");
}

/** Return whether a stop still owns the same live execution. */
export function ownsStoppedExecution(runtime: TurnRuntimeSnapshot, executionId: string | null): boolean {
  return isRunningRuntime(runtime) && runtime.turnExecutionId === executionId;
}

/** Derive the stop result from admission and provider dispatch state. */
export function stopDispatchState(
  runtime: TurnRuntimeSnapshot,
  dispatched: boolean | undefined,
  reservationState: string | undefined,
): AgentStopResult["dispatchState"] {
  if (!isRunningRuntime(runtime)) return "unknown";
  if (dispatched) return "dispatched";
  return reservationState === "activeTurn" || reservationState === "stopping" || reservationState === undefined
    ? "not-dispatched"
    : "unknown";
}
