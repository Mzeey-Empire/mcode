import { useEffect, useState, type RefObject } from "react";

/** Which horizontal scroll fade edges should be visible for an overflow container. */
export interface HorizontalScrollEdges {
  readonly left: boolean;
  readonly right: boolean;
}

/**
 * Tracks whether a horizontally scrollable element has hidden content on
 * either edge. Drives fade masks that hint overflow without adding controls.
 */
export function useHorizontalScrollEdges<T extends HTMLElement>(
  ref: RefObject<T | null>,
  /** Re-run the measurement when scrollable content changes (e.g. tab count). */
  contentKey?: number | string,
): HorizontalScrollEdges {
  const [edges, setEdges] = useState<HorizontalScrollEdges>({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = (): void => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setEdges({
        left: overflow && el.scrollLeft > 1,
        right: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [ref, contentKey]);

  return edges;
}
