import type { ThoughtSegment } from "./types";
import { DeltaBlock } from "./DeltaBlock";

/** Props for {@link ThoughtBlock}. */
interface ThoughtBlockProps {
  segment: ThoughtSegment;
  isActive: boolean;
}

/**
 * Renders a single text content block (formerly the "thought" row) as plain
 * body prose in the timeline.
 *
 * Despite the historical name, this component no longer dims or italicises
 * its content. The renderer was originally responsible for "preamble" text —
 * text streamed before a tool call with `stop_reason: tool_use`. The
 * Anthropic Messages API tags both pre-tool and post-tool text as `text`-typed
 * content blocks, and only `thinking`-typed blocks represent genuine internal
 * reasoning the user should not have to read. Rendering preamble text as a
 * dimmed aside hid the actual answer in flows like the goal stop-hook, where
 * the model answers fully before running a verification tool call.
 *
 * Delegates to `DeltaBlock` so live and persisted text rows share one
 * renderer — typewriter reveal and an end-of-text cursor while the segment
 * is still streaming, static prose once it has settled.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  return (
    <div className="px-2 py-1">
      <DeltaBlock text={segment.text} isStreaming={isActive} />
    </div>
  );
}
