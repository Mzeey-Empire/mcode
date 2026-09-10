import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitStreamingBlocks, type StreamingBlockPart } from "./streaming-blocks";
import { CodeBlock } from "@/components/chat/CodeBlock";

const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));
const LazyMermaidBlock = lazy(() => import("@/components/chat/MermaidBlock"));

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
  /**
   * When true, the typewriter reveals characters one-at-a-time. When false,
   * the text renders immediately at its full length and no animation runs.
   * Drives only the *reveal animation*, not the cursor caret — see
   * `showCursor` for that. Defaults to true (legacy delta-row usage).
   */
  isStreaming?: boolean;
  /**
   * When true, the typing caret blinks at the end of the rendered text while
   * `isStreaming` is also true. Set false for segments that are *animating
   * into view* but are not actively receiving more deltas — e.g. a just-closed
   * preamble thought re-typewriting into a `ThoughtBlock` after `tool_use`
   * fires. Without this gate, every closed thought would park a blinking
   * cursor at its end. Defaults to true.
   */
  showCursor?: boolean;
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
): { x: number; y: number; h: number } | null {
  const rootRect = root.getBoundingClientRect();
  if (lastTextNode.parentElement?.closest("p")) {
    const caretRect = getCaretRectAtEnd(lastTextNode);
    if (!caretRect) return null;
    return {
      x: caretRect.right - rootRect.left,
      y: caretRect.top - rootRect.top,
      h: Math.min(Math.max(caretRect.height || 16, 12), 28),
    };
  }
  const lastBlock = cursor.previousElementSibling;
  if (!lastBlock) return null;
  const blockRect = lastBlock.getBoundingClientRect();
  return { x: blockRect.left - rootRect.left, y: blockRect.bottom - rootRect.top, h: 16 };
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
 * Maximum initial `target` length we still consider a "fresh first delta
 * batch" rather than a remount into an in-flight stream. Typical first
 * flushes are 10-50 chars; thread-switch remounts bring back hundreds or
 * thousands. Above this threshold, the typewriter snaps to a point near the
 * end of `target` on its first effect so the user sees the typing edge
 * instead of a multi-hundred-char catch-up dump.
 */
const REMOUNT_TARGET_THRESHOLD = 96;

/**
 * On a detected remount, leave this many characters of trailing text
 * un-typed so a short typewriter reveal plays at the leading edge — the user
 * still perceives the response as "live" without watching the whole buffer
 * fast-forward.
 */
const REMOUNT_TAIL_CHARS = 24;

const TYPEWRITER_FRAME_MS = 32;
const DEFAULT_STEP_CEILING = 28;
const LONG_RESPONSE_STEP_CEILING = 160;
const LONG_RESPONSE_LENGTH = 2_000;

/**
 * Reveals `target` character-by-character at a steady rate, with adaptive
 * catch-up when the target races ahead of the displayed text.
 *
 * - When `isStreaming` is true on first mount with a SHORT initial target,
 *   `displayed` starts empty so the rAF loop animates from "" up to the
 *   current target (e.g. the first batched flush of text deltas) — producing
 *   a visible typewriter reveal instead of the full text popping in.
 * - When `isStreaming` is true on first mount with a LONG initial target,
 *   we assume a remount into an in-flight stream (e.g. thread-switch back
 *   during streaming). `displayed` starts at `target.length - REMOUNT_TAIL_CHARS`
 *   so only the last few chars typewriter in, avoiding the multi-hundred-char
 *   "dump" the user would otherwise see.
 * - When `isStreaming` is false on first mount, `displayed` starts at `target`
 *   so persisted history doesn't re-typewriter when scrolled into view. If a
 *   live node flips from streaming to persisted while the typewriter is still
 *   behind, the rAF loop keeps catching up instead of snapping to full height.
 *
 * Idle rate: ~6 chars every 32ms. Catch-up closes roughly 1/8 of the gap per
 * paint, with a higher cap for long responses so visible text still catches up
 * during large flushes.
 *
 * When `target` shrinks (e.g., the parent reset for a new turn), the
 * displayed value resets immediately and the animation cancels.
 */
function useTypewriter(target: string, isStreaming: boolean): string {
  // Lazy useState initializer runs exactly once at mount — the right place
  // to evaluate the remount heuristic, since later renders see `target`
  // grow but should not retro-actively change the starting point.
  const [displayed, setDisplayed] = useState<string>(() => {
    if (!isStreaming) return target;
    if (target.length <= REMOUNT_TARGET_THRESHOLD) return "";
    return target.slice(0, Math.max(0, target.length - REMOUNT_TAIL_CHARS));
  });
  const targetRef = useRef(target);
  const displayedRef = useRef(displayed);
  const rafRef = useRef<number | null>(null);
  const lastPaintAtRef = useRef<number>(0);

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

    const tick = (now: number): void => {
      const t = targetRef.current;
      const d = displayedRef.current;
      if (d.length >= t.length) {
        rafRef.current = null;
        return;
      }
      if (now - lastPaintAtRef.current < TYPEWRITER_FRAME_MS) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastPaintAtRef.current = now;
      const behind = t.length - d.length;
      const stepCeiling =
        t.length >= LONG_RESPONSE_LENGTH ? LONG_RESPONSE_STEP_CEILING : DEFAULT_STEP_CEILING;
      // A 32ms paint cadence keeps markdown parsing out of the rAF hot path.
      // Long targets get a larger step cap so large provider flushes catch up
      // without hundreds of full markdown re-renders.
      const step = Math.max(6, Math.min(stepCeiling, Math.ceil(behind / 8)));
      const next = t.slice(0, d.length + step);
      displayedRef.current = next;
      setDisplayed(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [target, isStreaming]);

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
 * close any backlog). Active streams render as plain pre-wrapped text; settled
 * blocks hand the final text to the markdown renderer.
 *
 * The cursor is anchored at the end of whatever is currently rendered via
 * a layout effect that measures `Range.getClientRects()` and positions the
 * cursor with `transform: translate3d()` plus a CSS transition. The cursor
 * stays a permanent child of the root <div> (React-owned, never re-parented)
 * to avoid corrupting React's fiber tree.
 */
/** Skeleton for a construct whose closing marker has not streamed in yet. */
function StreamingSkeleton({ label, rows, columns }: { label: string; rows: number; columns?: number }) {
  return (
    <div className="my-2" data-testid="streaming-skeleton" aria-label={label}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
        {label}
      </div>
      {columns === undefined ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-4 space-y-2">
          {Array.from({ length: Math.min(Math.max(1, rows), 8) }, (_, i) => (
            <div
              key={i}
              className="h-3 rounded bg-muted-foreground/15 animate-pulse"
              style={{ width: `${55 + ((i * 37) % 40)}%`, animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="h-8 bg-muted/50 border-b border-border/60 animate-pulse" />
          {Array.from({ length: Math.min(rows, 8) }, (_, r) => (
            <div key={r} className="flex border-b border-border/40 last:border-0">
              {Array.from({ length: Math.min(Math.max(1, columns), 8) }, (_, c) => (
                <div key={c} className="flex-1 px-3 py-2 border-r border-border/40 last:border-0">
                  <div
                    className="h-3 rounded bg-muted-foreground/15 animate-pulse"
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

/** A completed streamed table, matching MarkdownContent's table chrome. */
function StreamingTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border border-border rounded">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="border border-border bg-muted/50 px-3 py-1.5 text-left text-sm font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border border-border px-3 py-1.5 text-sm">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StreamingPart({ part }: { part: StreamingBlockPart }) {
  if (part.kind === "text") {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed">{part.text}</p>;
  }
  if (part.kind === "table") {
    return part.closed
      ? <StreamingTable header={part.header} rows={part.rows} />
      : <StreamingSkeleton label="table assembling" rows={part.rows.length} columns={part.header.length} />;
  }
  if (!part.closed) {
    const label = part.lang === "mermaid" ? "diagram" : part.lang || "code";
    return <StreamingSkeleton label={`${label} assembling`} rows={part.code.split("\n").length} />;
  }
  if (part.lang === "mermaid") {
    return (
      <Suspense
        fallback={
          <pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto text-sm font-mono">
            <code>{part.code}</code>
          </pre>
        }
      >
        <LazyMermaidBlock code={part.code} isStreaming={false} />
      </Suspense>
    );
  }
  // Closed fence content is stable, so `isStreaming` is false; highlighting is
  // deferred to the settled MarkdownContent pass instead of running mid-stream.
  return (
    <CodeBlock
      code={part.code}
      language={part.lang}
      languageLabel={part.lang || "text"}
      isStreaming={false}
      disableHighlighting
    />
  );
}

/**
 * Streaming body: plain pre-wrapped text plus constructs whose closing marker
 * has arrived. Full markdown stays out of the per-keystroke path; fenced blocks
 * and tables are the exception because their source stops changing once closed,
 * so each one renders exactly once. A construct still being typed renders as a
 * skeleton rather than raw syntax or a failed partial render.
 */
function StreamingBody({ text }: { text: string }) {
  const parts = useMemo(() => splitStreamingBlocks(text), [text]);
  if (!parts.some((part) => part.kind !== "text")) {
    return <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>;
  }
  return (
    <>
      {parts.map((part, index) => <StreamingPart key={index} part={part} />)}
    </>
  );
}

export function DeltaBlock({ text, isStreaming = true, showCursor = true }: DeltaBlockProps) {
  const displayed = useTypewriter(text, isStreaming);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  /** Tracks whether the first-paint entry flight animation has already played. */
  const hasFlownInRef = useRef<boolean>(false);
  // The cursor is rendered only when BOTH actively receiving deltas (the
  // typewriter reveal) AND `showCursor` is true. A just-closed thought that
  // animates into view still uses `isStreaming` for the typewriter, but turns
  // `showCursor` off so the caret doesn't park at the end of a finished block.
  const renderCursor = isStreaming && showCursor;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const cursor = cursorRef.current;
    if (!root || !cursor || !renderCursor) return;

    // If the markdown DOM is momentarily empty (Suspense in flight, or a
    // re-render between fallback and resolved children), keep the cursor at
    // its last position rather than hiding it. Hiding on every empty frame
    // produced visible flicker during fast streaming — the cursor would
    // disappear for one paint then fade back in.
    const lastTextNode = findLastTextNode(root);
    if (!lastTextNode) return;
    const caret = measureCaretPosition(root, cursor, lastTextNode);
    if (!caret) return;
    const { x, y, h } = caret;

    // First time visible text appears: play the entry flight animation.
    // We place the cursor at an offset (above-right of the caret) with no
    // transition, then force a reflow and enable the slow entry transition.
    // Subsequent per-character moves use the fast 90ms default transition.
    if (!hasFlownInRef.current && (cursor.style.opacity === "0" || cursor.style.opacity === "")) {
      cursor.style.transition = "none";
      cursor.style.transform = `translate3d(${x + 24}px, ${y - 28}px, 0)`;
      cursor.style.opacity = "0";
      // Force reflow so the browser registers the starting position before
      // we switch on the entry transition.
      void cursor.offsetHeight;
      cursor.style.transition =
        "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease-out 60ms";
      hasFlownInRef.current = true;
      // After the entry flight completes, restore the fast per-character transition.
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
  }, [displayed, renderCursor]);

  return (
    <div ref={rootRef} className="relative">
      {isStreaming ? (
        <StreamingBody text={displayed} />
      ) : (
        <Suspense
          fallback={
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {displayed}
            </p>
          }
        >
          <LazyMarkdownContent content={displayed} isStreaming={false} />
        </Suspense>
      )}
      {/* Cursor is mounted ONLY when actively streaming AND `showCursor` is
          true. The `.typing-cursor` class runs a CSS blink animation that
          overrides any inline opacity, so an unmounted-but-not-rendered cursor
          was previously blinking in the top-left corner of completed text
          blocks. `showCursor=false` is used by ThoughtBlock so just-closed
          preamble segments don't leave a blinking caret in the timeline. */}
      {renderCursor && (
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
      )}
    </div>
  );
}
