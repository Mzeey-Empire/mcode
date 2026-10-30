import { lazy, Suspense, useMemo } from "react";
import { committedStreamingText, splitStreamingBlocks } from "./streaming-blocks";
import { TURN_PROSE_CLASS } from "./narrative-layout";
import { stripPlanFences } from "@/lib/plan-fences";

const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));

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
   * When true, an unclosed plan fence stays hidden because more text may still close it.
   * Defaults to `isStreaming`; the turn can still be running after the text's own stream ended.
   */
  textMayContinue?: boolean;
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
  return { content: isStreaming ? committed : visibleText, skeletons };
}

/**
 * Agent response text that reveals finished paragraphs while `isStreaming`,
 * and the full text once it settles.
 *
 * Streaming and settled text share one `MarkdownContent` element, so settling
 * reconciles the paragraphs already shown instead of remounting them, and
 * markdown re-parses once per finished paragraph rather than per delta.
 */
export function DeltaBlock({ text, isStreaming = true, textMayContinue = isStreaming }: DeltaBlockProps) {
  const { content, skeletons } = useRevealedBlocks(text, isStreaming, textMayContinue);
  return (
    <div className={TURN_PROSE_CLASS}>
      {content !== "" && (
        <Suspense fallback={<p className="whitespace-pre-wrap">{content}</p>}>
          <LazyMarkdownContent content={content} isStreaming={false} />
        </Suspense>
      )}
      {skeletons.map((skeleton, index) => <StreamingSkeleton key={index} {...skeleton} />)}
    </div>
  );
}
