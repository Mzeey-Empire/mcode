import { useEffect, useState } from "react";
import type { ThreadMovePreflight } from "@mcode/contracts/ws/methods";
import { getTransport } from "@/transport";

/**
 * What the dialog knows about the thread's old folder. A move starts only from `ready`: the preflight carries the
 * notice that the old folder will be deleted and that other threads in it move along, so a move that starts
 * without it hides what the user is agreeing to.
 */
export type MovePreflightRead =
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly preflight: ThreadMovePreflight };

export interface MovePreflightState {
  readonly read: MovePreflightRead;
  /** Reads the preflight again after a failure. */
  readonly retry: () => void;
}

const PENDING: MovePreflightRead = { status: "pending" };

/** The preflight a ready read holds, or null while it is pending or failed. */
export function preflightOf(read: MovePreflightRead): ThreadMovePreflight | null {
  return read.status === "ready" ? read.preflight : null;
}

/** Reads the move preflight for a thread, and again each time {@link MovePreflightState.retry} runs. */
export function useMovePreflight(threadId: string): MovePreflightState {
  const [read, setRead] = useState<MovePreflightRead>(PENDING);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    getTransport().readThreadMovePreflight(threadId).then(
      // The server answers null for a thread that cannot move, so there is no folder to describe and the move
      // would be refused anyway.
      (preflight) => { if (current) setRead(preflight ? { status: "ready", preflight } : { status: "failed" }); },
      () => { if (current) setRead({ status: "failed" }); },
    );
    return () => { current = false; };
  }, [threadId, attempt]);
  const retry = () => {
    setRead(PENDING);
    setAttempt((count) => count + 1);
  };
  return { read, retry };
}
