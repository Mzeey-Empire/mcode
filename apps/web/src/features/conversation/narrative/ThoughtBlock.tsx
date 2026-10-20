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
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  return (
    <div className="pt-1">
      {/* No caret: once the agent moves on, its live text renders in the response
          slot, so a caret here would stack one per earlier segment. */}
      <DeltaBlock text={segment.text} isStreaming={isActive} showCursor={false} />
    </div>
  );
}
