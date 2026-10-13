import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnRevertPreview, TurnRevertResult, TurnRevertScope, TurnRevertedEvent } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { getTransport } from "@/transport";
import { RpcError } from "@/transport/ws-transport";
import type { RevertFailure } from "./revert-copy";

const MAX_SENDS = 5;

function isDisconnect(error: unknown): boolean {
  return error instanceof Error && !(error instanceof RpcError) && error.message === "WebSocket disconnected";
}

/**
 * Sends one revert mutation until it is answered. The caller's `requestId`
 * stays fixed across resends, and the server replays a settled request
 * instead of writing twice. RPCs park until the socket reopens, so each
 * resend waits for the reconnect.
 */
export async function sendUntilAnswered(send: () => Promise<TurnRevertResult>): Promise<TurnRevertResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!isDisconnect(error) || attempt >= MAX_SENDS) throw error;
    }
  }
}

/**
 * Applies a committed revert or undo to this window: the receipt joins the
 * timeline once, and snapshots refetch so `reverted` annotations update. Both
 * the mutation's own answer and the `turn.reverted` push call this.
 */
export function acceptTurnRevert({ threadId, receipt }: Pick<TurnRevertedEvent, "threadId" | "receipt">): void {
  useThreadStore.getState().appendServerNotice(threadId, receipt);
  void getTransport()
    .listSnapshots(threadId)
    .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
    .catch((error: unknown) => console.warn("[turn-revert] snapshot refetch failed", { threadId, error }));
}

/** What the confirm shows while one revert is planned and applied. */
export type TurnRevertState =
  | { readonly phase: "loading" }
  | { readonly phase: "preview"; readonly preview: TurnRevertPreview; readonly applying: boolean }
  /** `preview` is null when the plan itself could not load; only a ready preview can be retried. */
  | { readonly phase: "failed"; readonly preview: TurnRevertPreview | null; readonly failure: RevertFailure | RevertRequestError };

/** A request that threw instead of answering, such as a lost connection that never came back. */
export interface RevertRequestError {
  readonly status: "error";
  readonly detail: string;
}

/** Target of {@link useTurnRevert}: a whole turn, or one file over a range of turns. */
export interface TurnRevertTarget {
  readonly threadId: string;
  /** Server id of the turn's assistant message. */
  readonly messageId: string;
  readonly scope: TurnRevertScope;
}

/**
 * Plans and applies one revert. The preview loads on mount; `apply` sends it
 * with a fresh `requestId` per click, so Retry is a new request. `stale`
 * swaps in the new preview, and `reverted` calls `onReverted`.
 */
export function useTurnRevert(target: TurnRevertTarget, onReverted: () => void) {
  const { threadId, messageId, scope } = target;
  const scopeKey = JSON.stringify(scope);
  const key = `${threadId}
${messageId}
${scopeKey}`;
  const [keyed, setKeyed] = useState<{ readonly key: string; readonly state: TurnRevertState } | null>(null);
  const state: TurnRevertState = keyed?.key === key ? keyed.state : { phase: "loading" };
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const settle = (next: TurnRevertState) => { if (!cancelled) setKeyed({ key, state: next }); };
    getTransport()
      .previewTurnRevert(threadId, messageId, JSON.parse(scopeKey) as TurnRevertScope)
      .then(
        (preview) => settle({ phase: "preview", preview, applying: false }),
        (error: unknown) => settle({ phase: "failed", preview: null, failure: { status: "error", detail: errorDetail(error) } }),
      );
    return () => { cancelled = true; };
  }, [key, threadId, messageId, scopeKey]);

  const apply = useCallback(() => {
    const current = keyed?.key === key ? keyed.state : null;
    if (!current || current.phase === "loading" || current.preview?.status !== "ready") return;
    const preview = current.preview;
    const requestId = crypto.randomUUID();
    const settle = (next: TurnRevertState) => { if (mounted.current) setKeyed({ key, state: next }); };
    settle({ phase: "preview", preview, applying: true });
    const params = { threadId, messageId, scope, previewToken: preview.previewToken, requestId };
    sendUntilAnswered(() => getTransport().applyTurnRevert(params)).then(
      (result) => {
        if (result.status === "reverted") {
          acceptTurnRevert({ threadId, receipt: result.receipt });
          if (mounted.current) onReverted();
          return;
        }
        if (result.status === "stale") settle({ phase: "preview", preview: result.preview, applying: false });
        else settle({ phase: "failed", preview, failure: result });
      },
      (error: unknown) => settle({ phase: "failed", preview, failure: { status: "error", detail: errorDetail(error) } }),
    );
  }, [keyed, key, threadId, messageId, scope, onReverted]);

  return { state, apply };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
