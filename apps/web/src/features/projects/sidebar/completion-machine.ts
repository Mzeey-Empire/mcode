import type { ThreadCompletionRefusal } from "@mcode/contracts/ws/methods";

/** How long the server holds a completion before it commits, so Undo can cancel it. */
export const HOLD_MS = 3000;

/** Why a completion did not land. A refusal is the server's answer; a retryable failure is the connection's. */
export type CompletionFailure =
  | { readonly kind: "refused"; readonly refusal: Exclude<ThreadCompletionRefusal, "cancelled">; readonly message: string }
  | { readonly kind: "retryable"; readonly message: string };

/**
 * A thread's local completion. Absent means idle, or confirmed and settled. `attempt` ties each
 * reply to the request that produced it, so a reply that outlived an Undo is ignored.
 */
export type CompletionEntry =
  /** `thread.complete{holdMs}` is out and the server is holding it; the row is struck through in place. */
  | { readonly phase: "holding"; readonly attempt: number }
  /** Confirmed while the pointer rested on the row; it stays until the pointer leaves. */
  | { readonly phase: "lingering" }
  /** Back in Active with the reason and Retry. */
  | { readonly phase: "failed"; readonly failure: CompletionFailure };

export type CompletionEvent =
  | { readonly type: "complete"; readonly attempt: number }
  | { readonly type: "retry"; readonly attempt: number }
  | { readonly type: "undo" }
  | { readonly type: "confirmed"; readonly attempt: number; readonly pointerOnRow: boolean }
  | { readonly type: "refused"; readonly attempt: number; readonly refusal: ThreadCompletionRefusal }
  | { readonly type: "connection-failed"; readonly attempt: number; readonly message: string }
  | { readonly type: "pointer-left" }
  /** The server record turned completed or active by itself (auto-complete, another client, a send). */
  | { readonly type: "server-lifecycle"; readonly completed: boolean };

export type CompletionEffect =
  | { readonly type: "send-complete"; readonly attempt: number }
  | { readonly type: "send-reopen" }
  /** Apply the server's completed record to `workspaceStore`, which releases resources on that transition. */
  | { readonly type: "apply-confirmed" };

/** The next entry and the effects the store must run. */
export interface CompletionTransition {
  readonly next: CompletionEntry | undefined;
  readonly effects: readonly CompletionEffect[];
}

const REFUSAL_MESSAGES: Record<Exclude<ThreadCompletionRefusal, "cancelled">, string> = {
  running: "The thread is running",
  "approval-pending": "An approval is pending",
  busy: "The thread is busy",
};

function unchanged(entry: CompletionEntry | undefined): CompletionTransition {
  return { next: entry, effects: [] };
}

function fromIdle(event: CompletionEvent): CompletionTransition {
  if (event.type !== "complete") return unchanged(undefined);
  return { next: { phase: "holding", attempt: event.attempt }, effects: [{ type: "send-complete", attempt: event.attempt }] };
}

function refusedTransition(refusal: ThreadCompletionRefusal): CompletionTransition {
  if (refusal === "cancelled") return unchanged(undefined);
  return { next: { phase: "failed", failure: { kind: "refused", refusal, message: REFUSAL_MESSAGES[refusal] } }, effects: [] };
}

function fromHolding(entry: Extract<CompletionEntry, { phase: "holding" }>, event: CompletionEvent): CompletionTransition {
  if (event.type === "undo") return { next: undefined, effects: [{ type: "send-reopen" }] };
  if (!("attempt" in event) || event.attempt !== entry.attempt) return unchanged(entry);
  if (event.type === "confirmed") {
    return { next: event.pointerOnRow ? { phase: "lingering" } : undefined, effects: [{ type: "apply-confirmed" }] };
  }
  if (event.type === "refused") return refusedTransition(event.refusal);
  if (event.type === "connection-failed") {
    return { next: { phase: "failed", failure: { kind: "retryable", message: event.message } }, effects: [] };
  }
  return unchanged(entry);
}

function fromLingering(entry: CompletionEntry, event: CompletionEvent): CompletionTransition {
  if (event.type === "pointer-left") return unchanged(undefined);
  if (event.type === "undo") return { next: undefined, effects: [{ type: "send-reopen" }] };
  if (event.type === "server-lifecycle" && !event.completed) return unchanged(undefined);
  return unchanged(entry);
}

function fromFailed(entry: CompletionEntry, event: CompletionEvent): CompletionTransition {
  if (event.type === "retry") {
    return { next: { phase: "holding", attempt: event.attempt }, effects: [{ type: "send-complete", attempt: event.attempt }] };
  }
  if (event.type === "undo") return unchanged(undefined);
  if (event.type === "server-lifecycle" && event.completed) return unchanged(undefined);
  return unchanged(entry);
}

/**
 * Returns the next completion state and effects. Unlisted state/event pairs and stale attempts
 * leave the entry unchanged with no effects.
 */
export function transitionCompletion(entry: CompletionEntry | undefined, event: CompletionEvent): CompletionTransition {
  if (!entry) return fromIdle(event);
  if (entry.phase === "holding") return fromHolding(entry, event);
  if (entry.phase === "lingering") return fromLingering(entry, event);
  return fromFailed(entry, event);
}
