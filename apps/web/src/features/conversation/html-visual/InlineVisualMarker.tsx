import type { HtmlVisual } from "@mcode/contracts/models/html-visual";
import { useThreadStore } from "@/stores/threadStore";
import { HtmlVisualFrame } from "./HtmlVisualFrame";

/** Image source scheme an agent's reply uses to place a published visual: `![Title](visual:<message id>)`. */
export const VISUAL_MARKER_SCHEME = "visual:";

/** Returns the visual message id a markdown image source names, or undefined for any other source. */
export function visualMarkerMessageId(src: string | undefined): string | undefined {
  if (!src?.startsWith(VISUAL_MARKER_SCHEME)) return undefined;
  const id = src.slice(VISUAL_MARKER_SCHEME.length);
  return id === "" ? undefined : id;
}

/**
 * Shows the visual a reply's marker names, looked up only within the reply's own thread.
 * An unknown id shows the alt text, so a marker never becomes a broken image.
 */
export function InlineVisualMarker({ threadId, messageId, alt }: {
  readonly threadId: string | null;
  readonly messageId: string;
  readonly alt: string;
}) {
  // Selecting the visual object, not the message list, keeps unrelated message updates from re-rendering the reply.
  const visual = useThreadStore((state): HtmlVisual | undefined => {
    if (!threadId) return undefined;
    const message = state.records.get(threadId)?.messages.find((candidate) => candidate.id === messageId);
    return message?.role === "system" ? message.visual ?? undefined : undefined;
  });
  if (!visual) return <>{alt}</>;
  return <HtmlVisualFrame visual={visual} />;
}
