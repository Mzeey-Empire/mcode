import { lazy, Suspense, useLayoutEffect, useRef } from "react";

const LazyMarkdownContent = lazy(() => import("../MarkdownContent"));

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
}

/**
 * Finds the deepest last text-bearing element inside `root`.
 *
 * "Text-bearing" means an Element that has at least one descendant Text node
 * with non-whitespace content. We walk text nodes back-to-front and return
 * the parent of the last one with visible characters — across paragraphs,
 * list items, headings, code blocks, etc.
 */
function findLastTextElement(root: HTMLElement): HTMLElement | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    if (node.textContent && node.textContent.trim().length > 0) {
      last = node;
    }
    node = walker.nextNode() as Text | null;
  }
  return last?.parentElement ?? null;
}

/**
 * Streaming agent response with a typing cursor that trails the last word.
 *
 * The cursor stays a permanent child of the root `<div>` (React-owned, never
 * re-parented), and is positioned absolutely on top of the end of the last
 * text-bearing element via a layout effect. Earlier attempts that moved the
 * cursor into the markdown subtree broke React's reconciliation — when the
 * markdown tree changed mid-stream, `insertBefore` on the root's children
 * list threw because the cursor was no longer where the fiber tree expected.
 *
 * Uses the same MarkdownContent renderer as the final MessageBubble so the
 * visual swap on turnComplete is seamless (only the cursor disappears).
 */
export function DeltaBlock({ text }: DeltaBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const cursor = cursorRef.current;
    if (!root || !cursor) return;

    const target = findLastTextElement(root);
    if (!target) {
      cursor.style.visibility = "hidden";
      return;
    }

    // Collapse a range to the END of the target's last text content.
    // getBoundingClientRect on a collapsed range yields a zero-width box
    // positioned exactly after the last character — perfect for a cursor anchor.
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    let rect = range.getBoundingClientRect();

    // Some browsers return a zero-sized rect for a collapsed range across
    // certain element boundaries. Fall back to the target's full rect anchored
    // at its right edge so the cursor still trails the last visible content.
    if (rect.width === 0 && rect.height === 0) {
      const fallback = target.getBoundingClientRect();
      rect = new DOMRect(fallback.right, fallback.top, 0, fallback.height || 16);
    }

    const rootRect = root.getBoundingClientRect();
    cursor.style.visibility = "visible";
    cursor.style.left = `${rect.right - rootRect.left}px`;
    cursor.style.top = `${rect.top - rootRect.top}px`;
    cursor.style.height = `${rect.height || 16}px`;
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
          margin: 0,
          visibility: "hidden",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
