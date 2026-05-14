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
 * with non-whitespace content. We walk the tree depth-first from the back so
 * the returned element is the last leaf paragraph / list-item / heading the
 * markdown rendered. Code blocks count too — the cursor follows whatever was
 * streamed last.
 */
function findLastTextElement(root: HTMLElement): HTMLElement | null {
  // Walk text nodes back-to-front and return the parent of the last one with
  // visible characters.
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
 * The cursor is rendered as a sibling at first paint, then re-parented into
 * the deepest last text-bearing element of the rendered markdown via a layout
 * effect. This keeps the cursor on the same line as the last visible character
 * across paragraphs, lists, and code blocks — not stranded below the last
 * block element.
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
    if (target && cursor.parentElement !== target) {
      target.appendChild(cursor);
    }
    // Restore cursor to root before the next reconciliation. React expects
    // the cursor span to be a direct child of the root <div> (where it was
    // originally rendered). Without this, removeChild throws on unmount.
    return () => {
      if (cursor.parentElement !== root) {
        root.appendChild(cursor);
      }
    };
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
      <span ref={cursorRef} aria-hidden="true" className="typing-cursor" />
    </div>
  );
}
