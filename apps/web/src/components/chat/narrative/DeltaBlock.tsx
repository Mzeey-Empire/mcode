import { lazy, Suspense } from "react";

const LazyMarkdownContent = lazy(() => import("../MarkdownContent"));

interface DeltaBlockProps {
  /** The streamed response text to display. */
  text: string;
}

/**
 * Renders the streaming agent response - the final answer being composed
 * after all tool calls have completed.
 *
 * Uses the same `MarkdownContent` renderer as the final `MessageBubble`,
 * so when `turnComplete` fires and the real message replaces this block,
 * the visual swap is seamless (only the typing cursor disappears).
 *
 * The text shows with markdown formatting (bullets, bold, code blocks)
 * exactly as the final message will - not as a flat single paragraph.
 */
export function DeltaBlock({ text }: DeltaBlockProps) {
  return (
    <div className="relative">
      <Suspense
        fallback={
          <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed">
            {text}
          </p>
        }
      >
        <LazyMarkdownContent content={text} isStreaming={true} />
      </Suspense>
      <span aria-hidden="true" className="typing-cursor" />
    </div>
  );
}
