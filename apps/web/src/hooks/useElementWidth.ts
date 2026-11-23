import { useEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * Tracks the rendered width (in CSS pixels) of the element referenced by
 * `ref` via `ResizeObserver`. Returns `0` until the first measurement lands.
 *
 * Use this when responsiveness must depend on the *container* a component
 * actually occupies, not on the viewport. Example: the chat composer's
 * available width changes whenever the right panel opens or the sidebar
 * resizes — viewport media queries can't see that.
 *
 * Updates are throttled with `requestAnimationFrame` so a flurry of resize
 * notifications collapses into one state update per frame. A width that
 * crosses `breakpoint` instead commits before the current frame paints, for
 * layout that switches mode at that width and must not paint the old mode at
 * the new width.
 */
export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  observeKey?: unknown,
  breakpoint?: number,
): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Seed with the current size so consumers don't get a 0 → real flash
    // when the element is already laid out at mount time. Done unconditionally
    // so environments without ResizeObserver (older test runners, SSR
    // hydration) still get a valid initial measurement.
    let committed = el.getBoundingClientRect().width;
    setWidth(committed);

    if (typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    let pending = 0;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Modern browsers expose contentBoxSize as a readonly array; older ones
      // returned a single object. Fall back to contentRect for the rest.
      let next: number;
      if (entry.contentBoxSize) {
        const box = Array.isArray(entry.contentBoxSize)
          ? entry.contentBoxSize[0]
          : (entry.contentBoxSize as unknown as ResizeObserverSize);
        next = box.inlineSize;
      } else {
        next = entry.contentRect.width;
      }

      pending = next;
      // Observer callbacks run after layout and before paint, so a synchronous
      // render here lands in the frame that laid out the new width. Callers
      // pass a breakpoint only for an element whose own width does not depend
      // on that render, so it cannot re-trigger this observer in a loop.
      if (breakpoint !== undefined && (committed >= breakpoint) !== (next >= breakpoint)) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        committed = next;
        flushSync(() => setWidth(next));
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        committed = pending;
        setWidth(pending);
      });
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [ref, observeKey, breakpoint]);

  return width;
}
