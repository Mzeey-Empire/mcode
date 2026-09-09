import { useEffect, useState } from "react";
import type { ToolCall } from "@/transport/types";

/** A short-lived presentation state; provider completion remains immediate. */
export interface ToolCallTransition {
  readonly phase: "entering" | "exiting";
  readonly call: ToolCall;
  readonly expiresAt: number;
}

function updateTransitions(
  previous: readonly ToolCall[],
  calls: readonly ToolCall[],
  transitions: ReadonlyMap<string, ToolCallTransition>,
): ReadonlyMap<string, ToolCallTransition> {
  const prior = new Map(previous.map((call) => [call.id, call]));
  const next = new Map(transitions);
  const expiresAt = Date.now() + 250;
  for (const call of calls) {
    const old = prior.get(call.id);
    if (!old && !call.isComplete) next.set(call.id, { phase: "entering", call, expiresAt });
    else if (old && !old.isComplete && call.isComplete) next.set(call.id, { phase: "exiting", call: old, expiresAt });
  }
  const ids = new Set(calls.map((call) => call.id));
  for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
  return next;
}

/** Retains a completing tool's row for its exit, without delaying other live updates. */
export function useToolCallTransitions(calls: readonly ToolCall[]) {
  const [state, setState] = useState<{
    calls: readonly ToolCall[];
    transitions: ReadonlyMap<string, ToolCallTransition>;
  }>(() => ({ calls, transitions: new Map() }));
  if (state.calls !== calls) {
    setState({ calls, transitions: updateTransitions(state.calls, calls, state.transitions) });
  }
  useEffect(() => {
    if (state.transitions.size === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nextExpiry = Math.min(...Array.from(state.transitions.values(), (transition) => transition.expiresAt));
    // Match AnimatedCollapsible, with a separate deadline for each overlapping call.
    const timer = window.setTimeout(() => {
      setState((previous) => ({
        ...previous,
        transitions: new Map(Array.from(previous.transitions).filter(([, transition]) =>
          !reducedMotion && transition.expiresAt > Date.now())),
      }));
    }, reducedMotion ? 0 : Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.transitions]);
  return state.transitions;
}
