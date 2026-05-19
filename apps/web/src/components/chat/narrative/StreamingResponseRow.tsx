import { DeltaBlock } from "./DeltaBlock";

/** Props for {@link StreamingResponseRow}. */
export interface StreamingResponseRowProps {
  /** Live streaming text to render inline as the agent's in-flight response. */
  text: string;
}

/**
 * In-flight response row. Renders the streaming text in a container that
 * mirrors the assistant `MessageBubble`'s prose styling so that when the
 * turn persists and the bubble takes this slot, the swap reads as a content
 * replacement rather than a position jump.
 *
 * Lives in its own virtual-item slot (`streaming-response`) rather than
 * inside `NarrativeFlow`'s content tree — that way the persisted
 * `MessageBubble` mounts at the SAME virtual-list position the streaming
 * row vacated, and the visualiser doesn't reflow the surrounding rows.
 */
export function StreamingResponseRow({ text }: StreamingResponseRowProps) {
  if (text.length === 0) return null;
  return (
    <div className="group/msg space-y-2">
      <div className="text-sm text-foreground">
        <DeltaBlock text={text} isStreaming={true} />
      </div>
    </div>
  );
}
