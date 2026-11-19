import type { HtmlVisual } from "@mcode/contracts/models/html-visual";
import { useThreadStore } from "@/stores/threadStore";
import { HtmlVisualFrame } from "./HtmlVisualFrame";

/**
 * Shows the visual a reply's marker names, looked up only within the reply's own thread.
 * An unknown id shows the alt text, so a marker never becomes a broken image.
 */
export function InlineVisualMarker({ threadId, messageId, alt }: {
  readonly threadId: string | null;
  readonly messageId: string;
  readonly alt: string;
}) {
  const visual = useThreadStore((state): HtmlVisual | undefined => {
    if (!threadId) return undefined;
    const message = state.records.get(threadId)?.messages.find((candidate) => candidate.id === messageId);
    return message?.role === "system" ? message.visual ?? undefined : undefined;
  });
  if (!visual) return <>{alt}</>;
  return <HtmlVisualFrame visual={visual} />;
}
