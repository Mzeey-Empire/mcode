import type { AgentModelState, ScheduledTurnResume } from "@mcode/contracts";
import { latestThreadTurn, threadProviderLabel } from "../turn-ending/turn-endings-projection";
import { usageLimitLabel } from "../turn-ending/usage-limit";

/** The thread's latest turn, stopped by a provider usage limit. */
export interface UsageLimitStop {
  readonly turnId: string;
  /** Provider display name, e.g. "Codex". */
  readonly provider: string;
  /** The limit window, e.g. "5-hour limit"; undefined when the provider did not name it. */
  readonly limitLabel: string | undefined;
  readonly resetsAt: string | undefined;
}

/** What the composer tray's usage-limit row shows, or null when it is hidden. */
export type UsageLimitTrayState =
  | ({ readonly kind: "limit" } & UsageLimitStop)
  | { readonly kind: "scheduled"; readonly turnId: string; readonly at: string }
  | null;

/** The thread's latest turn when a usage limit interrupted it; any newer turn hides an older stop. */
export function latestUsageLimitStop(threadId: string, state: AgentModelState): UsageLimitStop | null {
  const turn = latestThreadTurn(threadId, state);
  const ending = turn?.status === "Interrupted" ? turn.ending : undefined;
  if (!turn || ending?.outcome !== "interrupted" || ending.cause !== "usage_limit") return null;
  return {
    turnId: turn.id,
    provider: threadProviderLabel(threadId, state),
    limitLabel: usageLimitLabel(ending.usageLimit?.limitType),
    resetsAt: ending.usageLimit?.resetsAt,
  };
}

/** The usage-limit row for a stop, its thread's scheduled resume, and whether the thread is running. */
export function usageLimitTrayState(
  stop: UsageLimitStop | null,
  scheduledResume: ScheduledTurnResume | null,
  running: boolean,
): UsageLimitTrayState {
  if (!stop || running) return null;
  // A schedule left over from an earlier stop does not belong to this one.
  if (scheduledResume?.turnId === stop.turnId) return { kind: "scheduled", turnId: stop.turnId, at: scheduledResume.at };
  return { kind: "limit", ...stop };
}
