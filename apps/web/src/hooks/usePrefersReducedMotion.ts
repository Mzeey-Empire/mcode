import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the user asked for reduced motion right now. For imperative code: event handlers, timers, classes. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the user asked for reduced motion, re-rendering when the preference changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
