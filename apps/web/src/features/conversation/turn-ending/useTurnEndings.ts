import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentModelState, ScheduledTurnRetry } from "@mcode/contracts";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import {
  nextRetryAtLapse,
  projectTurnEndings,
  reuseTurnEndings,
  type TurnEndingsProjection,
} from "./turn-endings-projection";

const NO_TURN_ENDINGS: TurnEndingsProjection = { endingsByMessageId: {}, hiddenMessageIds: new Set() };
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The thread's turn endings, re-projected when its provider signs in or out
 * so an auth failure's Sign in becomes Retry without a reload, and when a
 * usage limit's reset time passes so Retry at becomes Retry.
 */
export function useTurnEndings(
  threadId: string | null | undefined,
  state: AgentModelState,
  scheduledRetry: ScheduledTurnRetry | null,
): TurnEndingsProjection {
  const providerId = threadId ? state.threads[threadId]?.providerId : undefined;
  const providerSignedOut = useProviderStatusStore((store) =>
    store.statuses.some((status) => status.providerId === providerId && status.auth.state === "signed_out"),
  );
  const previous = useRef<TurnEndingsProjection | undefined>(undefined);
  // A reset time passing on an idle thread changes no store state, so a timer records the wake.
  const [wokeAt, setWokeAt] = useState(0);
  const projection = useMemo(() => {
    if (!threadId) return NO_TURN_ENDINGS;
    const next = projectTurnEndings(threadId, state, {
      providerSignedOut,
      scheduledRetry,
      now: Math.max(wokeAt, Date.now()),
    });
    previous.current = reuseTurnEndings(previous.current, next);
    return previous.current;
  }, [threadId, state, providerSignedOut, scheduledRetry, wokeAt]);
  const lapseAt = nextRetryAtLapse(projection);
  useEffect(() => {
    if (lapseAt === null) return;
    // Longer delays overflow setTimeout and fire at once; an early wake just re-arms.
    const delay = Math.min(Math.max(lapseAt - Date.now(), 0), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => setWokeAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [lapseAt, wokeAt]);
  return projection;
}
