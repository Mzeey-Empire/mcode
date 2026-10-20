import { lazy, Suspense, useLayoutEffect, useMemo, useRef } from "react";
import { committedStreamingText, splitStreamingBlocks } from "./streaming-blocks";
import { TURN_PROSE_CLASS } from "./narrative-layout";
import { stripPlanFences } from "@/lib/plan-fences";

const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));

/** Typing caret size from the Paper boards: a 2×18 bar centred on the prose line. */
const CARET_WIDTH_PX = 2;
const CARET_HEIGHT_PX = 18;
/** Gap between the last glyph and the caret. */
const CARET_GAP_PX = 2;

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
  /**
   * When true, the unfinished paragraph stays hidden until a blank line or
   * closing fence commits it; open fences and tables show a skeleton instead.
   * When false, the full text renders. Defaults to true.
   */
  isStreaming?: boolean;
  /**
   * Shows the typing caret while `isStreaming` is also true. Defaults to true.
   * `ThoughtBlock` turns it off so earlier narration segments don't each park a caret.
   */
  showCursor?: boolean;
  /**
   * When true, an unclosed plan fence stays hidden because more text may still close it.
   * Defaults to `isStreaming`; the turn can still be running after the text's own stream ended.
   */
  textMayContinue?: boolean;
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
 * Measures where the typing caret should sit relative to `root`: at the end of
 * the last text run when the stream ends in prose, or just below the last
 * rendered block when it ends in a skeleton, diagram, code block, or table —
 * those are not typing surfaces, so anchoring inside them (a skeleton caption
 * or a diagram's SVG label) would park the caret mid-block.
 */
function measureCaretPosition(
  root: HTMLElement,
  cursor: HTMLElement,
  lastTextNode: Text,
): CaretPosition | null {
  const rootRect = root.getBoundingClientRect();
  if (lastTextNode.parentElement?.closest("p")) {
    const caretRect = getCaretRectAtEnd(lastTextNode);
    if (!caretRect) return null;
    const lineHeight = caretRect.height || CARET_HEIGHT_PX;
    return {
      x: caretRect.right - rootRect.left + CARET_GAP_PX,
      y: caretRect.top - rootRect.top + (lineHeight - CARET_HEIGHT_PX) / 2,
      h: CARET_HEIGHT_PX,
    };
  }
  const lastBlock = cursor.previousElementSibling;
  if (!lastBlock) return null;
  const blockRect = lastBlock.getBoundingClientRect();
  return { x: blockRect.left - rootRect.left, y: blockRect.bottom - rootRect.top, h: CARET_HEIGHT_PX };
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

/** Skeleton for a construct whose closing marker has not streamed in yet. */
function StreamingSkeleton({ label, rows, columns }: { label: string; rows: number; columns?: number }) {
  return (
    <div className="my-2" data-testid="streaming-skeleton" aria-label={label}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
        {label}
      </div>
      {columns === undefined ? (
        <div className="rounded-lg border border-border/60 bg-hover/30 p-4 space-y-2">
          {Array.from({ length: Math.min(Math.max(1, rows), 8) }, (_, i) => (
            <div
              key={i}
              className="h-3 rounded bg-muted/15 animate-pulse"
              style={{ width: `${55 + ((i * 37) % 40)}%`, animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="h-8 bg-hover/50 border-b border-border/60 animate-pulse" />
          {Array.from({ length: Math.min(rows, 8) }, (_, r) => (
            <div key={r} className="flex border-b border-border/40 last:border-0">
              {Array.from({ length: Math.min(Math.max(1, columns), 8) }, (_, c) => (
                <div key={c} className="flex-1 px-3 py-2 border-r border-border/40 last:border-0">
                  <div
                    className="h-3 rounded bg-muted/15 animate-pulse"
                    style={{ animationDelay: `${(r * columns + c) * 70}ms` }}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PendingSkeleton {
  label: string;
  rows: number;
  columns?: number;
}

function pendingSkeletons(tail: string): PendingSkeleton[] {
  const skeletons: PendingSkeleton[] = [];
  for (const part of splitStreamingBlocks(tail)) {
    if (part.kind === "text" || part.closed) continue;
    if (part.kind === "table") {
      skeletons.push({ label: "table assembling", rows: part.rows.length, columns: part.header.length });
    } else {
      const label = part.lang === "mermaid" ? "diagram" : part.lang || "code";
      skeletons.push({ label: `${label} assembling`, rows: part.code.split("\n").length });
    }
  }
  return skeletons;
}

function useRevealedBlocks(text: string, isStreaming: boolean, textMayContinue: boolean) {
  const visibleText = useMemo(() => stripPlanFences(text, textMayContinue), [text, textMayContinue]);
  const { committed, tail } = useMemo(() => committedStreamingText(visibleText), [visibleText]);
  const skeletons = useMemo(() => (isStreaming ? pendingSkeletons(tail) : []), [isStreaming, tail]);
  return {
    content: isStreaming ? committed : visibleText,
    skeletons,
    // Open skeletons grow a row at a time, which moves a caret parked below them.
    skeletonLayoutKey: skeletons.map((skeleton) => `${skeleton.label}:${skeleton.rows}`).join("|"),
  };
}

interface CaretPosition {
  x: number;
  y: number;
  h: number;
}

/** Null when nothing measurable has rendered; the caret then keeps its last position instead of flickering. */
function measureCommittedCaret(root: HTMLElement, cursor: HTMLElement): CaretPosition | null {
  const lastTextNode = findLastTextNode(root);
  return lastTextNode ? measureCaretPosition(root, cursor, lastTextNode) : null;
}

/** Moves the caret, playing an entry flight from above-right the first time it appears. */
function moveCaret(cursor: HTMLElement, { x, y, h }: CaretPosition, hasFlownInRef: { current: boolean }): void {
  if (!hasFlownInRef.current && (cursor.style.opacity === "0" || cursor.style.opacity === "")) {
    cursor.style.transition = "none";
    cursor.style.transform = `translate3d(${x + 24}px, ${y - 28}px, 0)`;
    cursor.style.opacity = "0";
    // Forces a style flush so the browser registers the start position before the transition.
    void cursor.offsetHeight;
    cursor.style.transition =
      "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease-out 60ms";
    hasFlownInRef.current = true;
    const restoreFastTransition = (): void => {
      cursor.style.transition =
        "transform 90ms cubic-bezier(0.33, 1, 0.68, 1), opacity 140ms ease-out";
      cursor.removeEventListener("transitionend", restoreFastTransition);
    };
    cursor.addEventListener("transitionend", restoreFastTransition);
  }
  cursor.style.opacity = "1";
  cursor.style.height = `${h}px`;
  cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Agent response text that reveals finished paragraphs while `isStreaming`, with
 * a typing caret after the last one, and the full text once it settles.
 *
 * Streaming and settled text share one `MarkdownContent` element, so settling
 * reconciles the paragraphs already shown instead of remounting them, and
 * markdown re-parses once per finished paragraph rather than per delta.
 * The caret is React-owned: never move it with DOM calls (narrative-pipeline.md).
 */
export function DeltaBlock({ text, isStreaming = true, showCursor = true, textMayContinue = isStreaming }: DeltaBlockProps) {
  const { content, skeletons, skeletonLayoutKey } = useRevealedBlocks(text, isStreaming, textMayContinue);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  /** Tracks whether the first-paint entry flight animation has already played. */
  const hasFlownInRef = useRef<boolean>(false);
  const renderCursor = isStreaming && showCursor;
  const parkAtStart = renderCursor && content === "" && skeletons.length === 0;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const cursor = cursorRef.current;
    if (!root || !cursor || !renderCursor) return;
    const caret = parkAtStart ? { x: 0, y: 0, h: CARET_HEIGHT_PX } : measureCommittedCaret(root, cursor);
    if (caret) moveCaret(cursor, caret, hasFlownInRef);
  }, [content, skeletonLayoutKey, parkAtStart, renderCursor]);

  return (
    <div
      ref={rootRef}
      className={`relative ${TURN_PROSE_CLASS}`}
      style={parkAtStart ? { minHeight: `${CARET_HEIGHT_PX}px` } : undefined}
    >
      {content !== "" && (
        <Suspense fallback={<p className="whitespace-pre-wrap">{content}</p>}>
          <LazyMarkdownContent content={content} isStreaming={false} />
        </Suspense>
      )}
      {skeletons.map((skeleton, index) => <StreamingSkeleton key={index} {...skeleton} />)}
      {/* Mounted only while the caret should show: `.typing-cursor` runs a CSS
          blink that overrides inline opacity, so a hidden-but-mounted caret
          would blink in the corner of finished blocks. */}
      {renderCursor && (
      <span
        ref={cursorRef}
        aria-hidden="true"
        className="typing-cursor"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${CARET_WIDTH_PX}px`,
          margin: 0,
          opacity: 0,
          pointerEvents: "none",
          willChange: "transform, opacity",
          transition:
            "transform 90ms cubic-bezier(0.33, 1, 0.68, 1), opacity 140ms ease-out",
        }}
      />
      )}
    </div>
  );
}
