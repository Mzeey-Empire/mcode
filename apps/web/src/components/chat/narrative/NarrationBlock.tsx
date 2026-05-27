import type { NarrationSegment } from "./types";
import { DeltaBlock } from "./DeltaBlock";

/** Props for {@link NarrationBlock}. */
interface NarrationBlockProps {
  segment: NarrationSegment;
  isActive: boolean;
}

/**
 * Renders a single narration row — the agent's pre-tool-call narration text —
 * as plain body prose in the timeline.
 *
 * Narration segments are text the model streams before invoking a tool
 * (`stop_reason: tool_use`), distinct from the final-response text and from
 * SDK reasoning blocks (extended thinking). They render as regular prose, not
 * dimmed or italicised: the model often answers fully in this position before
 * running a verification tool call, so dimming would hide the actual answer.
 *
 * Delegates to `DeltaBlock` so live and persisted text rows share one
 * renderer — typewriter reveal and an end-of-text cursor while the segment
 * is still streaming, static prose once it has settled.
 */
export function NarrationBlock({ segment, isActive }: NarrationBlockProps) {
  return (
    <div className="px-2 py-1">
      {/* `showCursor={false}` — a narration row rendered in the timeline is
          either settled (turn over) or just-closed because a tool_use boundary
          fired. In neither case is the agent actively typing INTO this block:
          the next deltas land in a different segment (or in the streaming
          response slot below). Suppressing the caret here prevents stacking
          multiple blinking cursors across the timeline as preamble segments
          accumulate. The typewriter reveal still plays via `isStreaming`. */}
      <DeltaBlock text={segment.text} isStreaming={isActive} showCursor={false} />
    </div>
  );
}
