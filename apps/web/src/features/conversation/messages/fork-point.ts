import type { Message } from "@/transport";
import { assistantShowsActionRow } from "./MessageBubble";
import { agentActionsDisabledFor } from "./timeline/TranscriptItemRenderer";
import type { MessageListItem } from "./message-list-virtualization";

/** Where the thread header forks from: the reply the transcript shows Fork on, or why there is none. */
export type ThreadForkPoint = { readonly threadId: string } & (
  | { readonly kind: "ready"; readonly message: Message }
  | { readonly kind: "no-reply" }
  | { readonly kind: "newer-not-loaded" }
);

/** The latest agent reply in the rendered items that shows a Fork button, or null. */
export function latestForkableReply(
  items: readonly MessageListItem[],
  planMessageIds: ReadonlySet<string>,
): Message | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "message") continue;
    const { message, agentDisplayState, textIsStreaming } = item;
    if (message.role !== "assistant" || message.is_internal) continue;
    if (agentActionsDisabledFor(agentDisplayState)) continue;
    if (assistantShowsActionRow(message, { agentDisplayState, textIsStreaming, hasPlan: planMessageIds.has(message.id) })) return message;
  }
  return null;
}

/** The fork point for one rendered transcript window; a window missing newer pages cannot see the latest reply. */
export function threadForkPoint(threadId: string, latestReply: Message | null, hasNewer: boolean): ThreadForkPoint {
  if (hasNewer) return { threadId, kind: "newer-not-loaded" };
  return latestReply ? { threadId, kind: "ready", message: latestReply } : { threadId, kind: "no-reply" };
}
