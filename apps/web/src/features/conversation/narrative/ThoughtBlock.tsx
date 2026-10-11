import type { ThoughtSegment } from "./types";
import { DeltaBlock } from "./DeltaBlock";

/** Props for {@link ThoughtBlock}. */
interface ThoughtBlockProps {
  segment: ThoughtSegment;
  isActive: boolean;
}

/**
 * Renders a single narration segment as plain body prose in the timeline.
 *
 * Despite the historical name, this component renders narration, not model
 * reasoning. Narration is text the agent says to the user before or between
 * tool calls. Rendering it as a dimmed aside hid the actual answer in flows
 * like the goal stop-hook, where the model answers fully before running a
 * verification tool call. Reasoning blocks (`reasoningDelta`, segment kind
 * `reasoning`) render through `ThoughtRow` as a collapsed row instead.
 *
 * Delegates to `DeltaBlock` so live and persisted text rows share one
 * renderer — typewriter reveal and an end-of-text cursor while the segment
 * is still streaming, static prose once it has settled.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  return (
    <div className="pt-1">
      {/* `showCursor={false}` — a thought rendered in the timeline is either
          settled (turn over) or just-closed because a tool_use boundary
          fired. In neither case is the agent actively typing INTO this block:
          the next deltas land in a different segment (or in the streaming
          response slot below). Suppressing the caret here prevents stacking
          multiple blinking cursors across the timeline as preamble segments
          accumulate. The typewriter reveal still plays via `isStreaming`. */}
      <DeltaBlock text={segment.text} isStreaming={isActive} showCursor={false} />
    </div>
  );
}
