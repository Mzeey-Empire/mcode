import { lazy, Suspense, useLayoutEffect, useRef } from "react";

const LazyMarkdownContent = lazy(() => import("../MarkdownContent"));

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
}

/**
 * Walks all text nodes inside `root` back-to-front and returns the last one
 * with non-whitespace content. Returning the Text node itself (not its
 * parent element) lets the caller position a Range at the exact end offset
 * — yielding a precise caret-shaped rect rather than the bounding box of
 * the surrounding element.
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
 * Returns the caret rect at the END of the given text node.
 *
 * Uses `getClientRects()` on a zero-length Range positioned at the node's
 * end offset. For multi-line text this returns one rect per line; we take
 * the last (where the caret would actually sit). Returns `null` when no
 * meaningful rect can be measured.
 */
function getCaretRectAtEnd(node: Text): DOMRect | null {
  const len = node.textContent?.length ?? 0;
  if (len === 0) return null;
  const range = document.createRange();
  range.setStart(node, len);
  range.setEnd(node, len);
  let rects = range.getClientRects();
  if (rects.length === 0) {
    // Collapsed range across line/box boundary — measure the last character
    // and synthesise a zero-width rect anchored at its right edge.
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
 * Streaming agent response with a typing cursor anchored at the end of the
 * last visible character.
 *
 * Positioning uses `transform: translate3d()` with a short CSS transition so
 * the cursor glides smoothly as new text streams in, rather than jumping
 * discretely between layouts. The cursor stays a permanent child of the
 * root <div> (React-owned, never re-parented) — re-parenting mid-stream
 * corrupts React's fiber tree and crashes the commit phase.
 *
 * Visibility is controlled via inline opacity with its own transition, so
 * the cursor fades out cleanly when there's no measurable caret position
 * (empty markdown, mid-render, after final delta).
 */
export function DeltaBlock({ text }: DeltaBlockProps) {
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
    // Clamp height to a sane line-height upper bound so a glitched
    // measurement (e.g. a full block rect) never paints a giant bar.
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
            {text}
          </p>
        }
      >
        <LazyMarkdownContent content={text} isStreaming={true} />
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
