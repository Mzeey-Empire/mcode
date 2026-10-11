import { useCallback, useEffect, useState } from "react";

/** Keeps virtual group children present until their disclosure transition finishes. */
export function useTranscriptGroupExpansion(initialExpanded: () => ReadonlySet<string>) {
  const [state, setState] = useState(() => {
    const expanded = initialExpanded();
    return { expanded, present: expanded, entering: new Set<string>() };
  });
  /** Closing clears the linked keys too, since any of them holds the same disclosure open. */
  const toggle = useCallback((key: string, linkedKeys: readonly string[] = []) => {
    setState((previous) => {
      const expanded = new Set(previous.expanded);
      const entering = new Set(previous.entering);
      const keys = [key, ...linkedKeys];
      if (keys.some((open) => expanded.has(open))) for (const open of keys) expanded.delete(open);
      else {
        expanded.add(key);
        if (!previous.present.has(key)) entering.add(key);
      }
      return { expanded, present: new Set([...previous.present, key]), entering };
    });
  }, []);
  useEffect(() => {
    if (state.present === state.expanded) return;
    // Match AnimatedCollapsible's duration while keeping offscreen children virtualized.
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
    const timer = window.setTimeout(() => {
      setState((previous) => ({ ...previous, present: previous.expanded, entering: new Set() }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state.expanded, state.present]);
  return { ...state, toggle };
}
