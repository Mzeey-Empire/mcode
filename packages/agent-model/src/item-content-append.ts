import type { AgentItem } from "./records.js";

/** One append to an item's string `payload.content`, independent of transport and storage. */
export interface ItemContentAppend {
  /** UTF-16 length of `payload.content` before this append. */
  readonly offset: number;
  readonly text: string;
  readonly updatedAt: string;
}

/** Outcome of extending an item's content at an offset. */
export type ItemContentAppendResult =
  | { readonly kind: "appended"; readonly item: AgentItem }
  | { readonly kind: "already-applied" }
  | { readonly kind: "base-mismatch" };

/**
 * Extends `item.payload.content` when `offset` is its current length.
 *
 * Text already present at `offset` is "already-applied", so replaying the
 * newest append after the server compacts event identity cannot double the
 * text. Older replays never reach this function: the reducer's sequence
 * watermark rejects them first. Any other base is "base-mismatch"; a delta is
 * never applied to an unknown base.
 */
export function appendItemContent(item: AgentItem, append: ItemContentAppend): ItemContentAppendResult {
  const content = item.payload.content;
  if (typeof content !== "string") return { kind: "base-mismatch" };
  if (content.length === append.offset) {
    return {
      kind: "appended",
      item: { ...item, updatedAt: append.updatedAt, payload: { ...item.payload, content: content + append.text } },
    };
  }
  if (content.startsWith(append.text, append.offset)) {
    return { kind: "already-applied" };
  }
  return { kind: "base-mismatch" };
}
