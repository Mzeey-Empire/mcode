import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";

const LazyMarkdownContent = lazy(() => import("../MarkdownContent"));

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
}

/**
 * Walks all text nodes inside `root` back-to-front and returns the last one
 * with non-whitespace content. Returning the Text node itself (not its
 * parent element) lets the caller position a Range at the exact end offset.
 */
function findLastTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    if (node.textContent && node.textContent.trim().length > 0) {
      last = node;
    }
    node = walker.nextNode() as Text | null;
  }
  return last;
}

/**
 * Returns the caret rect at the END of the given text node, or null when
 * no meaningful rect can be measured.
 */
function getCaretRectAtEnd(node: Text): DOMRect | null {
  const len = node.textContent?.length ?? 0;
  if (len === 0) return null;
  const range = document.createRange();
  range.setStart(node, len);
  range.setEnd(node, len);
  let rects = range.getClientRects();
  if (rects.length === 0) {
    range.setStart(node, len - 1);
    range.setEnd(node, len);
    rects = range.getClientRects();
    if (rects.length === 0) return null;
    const last = rects[rects.length - 1];
    return new DOMRect(last.right, last.top, 0, last.height);
  }
  return rects[rects.length - 1];
}

/**
 * Reveals `target` character-by-character at a steady rate, with adaptive
 * catch-up when the target races ahead of the displayed text.
 *
 * Idle rate: ~3 chars per animation frame (≈180 chars/sec at 60fps).
 * Catch-up: `step = max(3, ceil(behind / 10))` — each frame closes 1/10 of
 * the gap, so a 1000-char buffer drains in well under a second.
 *
 * When `target` shrinks (e.g., the parent reset for a new turn), the
 * displayed value resets immediately and the animation cancels.
 */
function useTypewriter(target: string): string {
  const [displayed, setDisplayed] = useState(target);
  const targetRef = useRef(target);
  const displayedRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  // Mirror current target / displayed into refs so the rAF tick (which
  // closes over the first render only) always reads fresh values.
  targetRef.current = target;
  displayedRef.current = displayed;

  useEffect(() => {
    // New turn (or any shrink): snap to target, kill the loop.
    if (target.length < displayedRef.current.length) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplayed(target);
      return;
    }
    // Already caught up: nothing to animate.
    if (target === displayedRef.current) return;
    // Loop already in flight: it'll see the new target via the ref.
    if (rafRef.current != null) return;

    const tick = (): void => {
      const t = targetRef.current;
      const d = displayedRef.current;
      if (d.length >= t.length) {
        rafRef.current = null;
        return;
      }
      const behind = t.length - d.length;
      const step = Math.max(3, Math.ceil(behind / 10));
      const next = t.slice(0, d.length + step);
      displayedRef.current = next;
      setDisplayed(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [target]);

  // Cancel any in-flight frame on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  return displayed;
}

/**
 * Streaming agent response with a typewriter reveal and a typing cursor.
 *
 * Incoming `text` deltas are buffered by `useTypewriter`, which advances the
 * displayed text at a steady rate (≈180 chars/sec when idle, scaling up to
 * close any backlog). The markdown renderer always receives the typewriter
 * output, so users see characters form rather than whole chunks pop in.
 *
 * The cursor is anchored at the end of whatever is currently rendered via
 * a layout effect that measures `Range.getClientRects()` and positions the
 * cursor with `transform: translate3d()` plus a CSS transition. The cursor
 * stays a permanent child of the root <div> (React-owned, never re-parented)
 * to avoid corrupting React's fiber tree.
 */
export function DeltaBlock({ text }: DeltaBlockProps) {
  const displayed = useTypewriter(text);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const cursor = cursorRef.current;
    if (!root || !cursor) return;

    const lastTextNode = findLastTextNode(root);
    if (!lastTextNode) {
      cursor.style.opacity = "0";
      return;
    }
    const caretRect = getCaretRectAtEnd(lastTextNode);
    if (!caretRect) {
      cursor.style.opacity = "0";
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const x = caretRect.right - rootRect.left;
    const y = caretRect.top - rootRect.top;
    const h = Math.min(Math.max(caretRect.height || 16, 12), 28);

    cursor.style.opacity = "1";
    cursor.style.height = `${h}px`;
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  });

  return (
    <div ref={rootRef} className="relative">
      <Suspense
        fallback={
          <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed">
            {displayed}
          </p>
        }
      >
        <LazyMarkdownContent content={displayed} isStreaming={true} />
      </Suspense>
      <span
        ref={cursorRef}
        aria-hidden="true"
        className="typing-cursor"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "1.5px",
          margin: 0,
          opacity: 0,
          pointerEvents: "none",
          willChange: "transform, opacity",
          transition:
            "transform 90ms cubic-bezier(0.33, 1, 0.68, 1), opacity 140ms ease-out",
        }}
      />
    </div>
  );
}
