import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type RefObject } from "react";

/** Reports which changed file the reader is on. The default ignores reports, for lists outside a Review panel. */
export const ReviewActiveFileContext = createContext<(path: string) => void>(() => {});

/** How far below the viewport top a file header counts as passed. Exceeds the jump's 8px offset so a jump lands on its target. */
const PASSED_OFFSET_PX = 24;
/** Scroll events this soon after a jump belong to the jump, not to the reader. */
const JUMP_HOLD_MS = 250;
const BOTTOM_TOLERANCE_PX = 2;

interface ItemTopSource {
  getTopForItem(id: string): number | undefined;
}

interface ScrollSample {
  readonly scrollTop: number;
  readonly viewer: ItemTopSource;
}

/**
 * The last file whose header has scrolled past `y`. Item tops only grow with
 * file order, so a binary search finds it in log n lookups per scroll event.
 */
function fileAt(files: readonly { readonly path: string }[], viewer: ItemTopSource, y: number): string | undefined {
  let low = 0;
  let high = files.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const top = viewer.getTopForItem(files[mid]!.path) ?? Infinity;
    if (top <= y) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return files[found]?.path;
}

/**
 * Follows the diff's scroll position and reports the file under the viewport
 * top. At the end of the scroll range the last file wins, since a short final
 * file can never reach the top.
 */
export function useReviewScrollSpy(
  files: readonly { readonly path: string }[],
  scrollerRef: RefObject<HTMLElement | null>,
  comparisonId: string,
) {
  const report = useContext(ReviewActiveFileContext);
  const filesRef = useRef(files);
  const reportRef = useRef(report);
  const heldUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSample = useRef<ScrollSample | null>(null);
  const lastReported = useRef<string | null>(null);
  filesRef.current = files;
  reportRef.current = report;

  const emit = useCallback((path: string | undefined) => {
    if (!path || path === lastReported.current) return;
    lastReported.current = path;
    reportRef.current(path);
  }, []);

  const follow = useCallback(
    (sample: ScrollSample) => {
      const list = filesRef.current;
      const scroller = scrollerRef.current;
      const atEnd = scroller !== null && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_TOLERANCE_PX;
      emit(atEnd && sample.scrollTop > 0 ? list[list.length - 1]?.path : fileAt(list, sample.viewer, sample.scrollTop + PASSED_OFFSET_PX));
    },
    [emit, scrollerRef],
  );

  // A scroll that lands inside the hold is kept and replayed when the hold ends,
  // so a reader who moves on right after a jump is not left on the jump target.
  const onScroll = useCallback(
    (scrollTop: number, viewer: ItemTopSource) => {
      const sample = { scrollTop, viewer };
      lastSample.current = sample;
      const remaining = heldUntil.current - Date.now();
      if (remaining <= 0) return follow(sample);
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        follow(sample);
      }, remaining);
    },
    [follow],
  );

  /** Marks a scroll the app started, so the spy does not hand the active file back to a neighbour. */
  const holdForJump = useCallback((path: string) => {
    heldUntil.current = Date.now() + JUMP_HOLD_MS;
    emit(path);
  }, [emit]);

  const firstPath = files[0]?.path;
  // The scroller keeps its position when a comparison refreshes in place, so a
  // scrolled reader is re-read from the diff; only an unscrolled one starts at the first file.
  useEffect(() => {
    lastReported.current = null;
    const sample = lastSample.current;
    if (!sample || !scrollerRef.current || scrollerRef.current.scrollTop <= 0) return emit(firstPath);
    const frame = requestAnimationFrame(() => follow(sample));
    return () => cancelAnimationFrame(frame);
  }, [comparisonId, emit, firstPath, follow, scrollerRef]);

  useEffect(() => () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
  }, []);

  return useMemo(() => ({ onScroll, holdForJump }), [onScroll, holdForJump]);
}
