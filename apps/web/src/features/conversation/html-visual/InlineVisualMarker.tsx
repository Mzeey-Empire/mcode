import { useEffect, useRef } from "react";
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
  const requestedOlderPage = useRef(false);
  const isMissing = !visual;
  useEffect(() => {
    // A thread opens with only its newest messages, so the visual may sit one page back.
    // One request per marker: a page that still lacks it leaves the title as text.
    if (!isMissing || !threadId || requestedOlderPage.current) return;
    requestedOlderPage.current = true;
    void useThreadStore.getState().loadOlderMessages(threadId);
  }, [isMissing, threadId]);
  if (!visual) return <>{alt}</>;
  return <HtmlVisualFrame visual={visual} />;
}
