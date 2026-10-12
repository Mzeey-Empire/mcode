import { useMemo, useRef } from "react";
import type { AgentModelState } from "@mcode/contracts";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { projectTurnEndings, reuseTurnEndings, type TurnEndingsProjection } from "./turn-endings-projection";

const NO_TURN_ENDINGS: TurnEndingsProjection = { endingsByMessageId: {}, hiddenMessageIds: new Set() };

/**
 * The thread's turn endings, re-projected when its provider signs in or out
 * so an auth failure's Sign in becomes Retry without a reload.
 */
export function useTurnEndings(threadId: string | null | undefined, state: AgentModelState): TurnEndingsProjection {
  const providerId = threadId ? state.threads[threadId]?.providerId : undefined;
  const providerSignedOut = useProviderStatusStore((store) =>
    store.statuses.some((status) => status.providerId === providerId && status.auth.state === "signed_out"),
  );
  const previous = useRef<TurnEndingsProjection | undefined>(undefined);
  return useMemo(() => {
    if (!threadId) return NO_TURN_ENDINGS;
    previous.current = reuseTurnEndings(previous.current, projectTurnEndings(threadId, state, providerSignedOut));
    return previous.current;
  }, [threadId, state, providerSignedOut]);
}
