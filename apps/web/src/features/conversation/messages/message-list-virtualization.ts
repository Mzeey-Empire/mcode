import type { ReactNode } from "react";
import type { ChatVirtualItem } from "./virtual-items";
import type { TranscriptFoldNoteItem, TranscriptNarrativeItem, TranscriptToolItem } from "./transcript-narrative-items";

/** A transcript row rendered before the persisted conversation items. */
export type MessageListItem = ChatVirtualItem | TranscriptNarrativeItem | TranscriptToolItem | TranscriptFoldNoteItem | {
  readonly key: "leading-content";
  readonly type: "leading-content";
  readonly content: ReactNode;
} | {
  readonly key: "after-first-user-content";
  readonly type: "after-first-user-content";
  readonly content: ReactNode;
};

/** Fallback height used until a virtual row is rendered and measured. */
export const DEFAULT_MESSAGE_LIST_ITEM_HEIGHT = 80;

const PROVISIONAL_HEIGHT_BY_ITEM_TYPE: Record<ChatVirtualItem["type"], number> = {
  "message": 128,
  "turn-changes": 76,
  "permission-request": 72,
  "narrative-flow": 144,
  "work-fold": 32,
  "turn-meta-line": 24,
  "narrative-indicator": 36,
};

/**
 * Provides a stable initial size before the viewport measures the rendered row.
 * The DOM measurement is the source of truth. These values intentionally depend
 * only on row kind, never on an attempt to parse markdown in the list layer.
 */
export function estimateMessageListItemHeight(item: MessageListItem): number {
  if (item.type === "tool-row") return 32;
  if (item.type === "fold-note") return 20;
  if (item.type === "narrative-row") return item.item.type === "thought" ? 80 : 32;
  return item.type === "leading-content" || item.type === "after-first-user-content"
    ? DEFAULT_MESSAGE_LIST_ITEM_HEIGHT
    : PROVISIONAL_HEIGHT_BY_ITEM_TYPE[item.type];
}

/** Finds a persisted message row in the current virtual item window. */
export function findMessageListItemIndex(items: MessageListItem[], messageId: string | undefined): number {
  if (!messageId) return -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "message" && item.message.id === messageId) return index;
  }
  return -1;
}
