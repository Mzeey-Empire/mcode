import { useState } from "react";
import { create } from "zustand";
import type { Message } from "@mcode/contracts";

interface Announcement {
  readonly threadId: string;
  readonly receiptId: string;
  readonly text: string;
}

const useAnnouncement = create<{ latest: Announcement | null }>(() => ({ latest: null }));

/** Queue a live revert or undo receipt for screen readers. Hydrated history never calls this. */
export function announceTurnRevert(threadId: string, receipt: Message): void {
  if (useAnnouncement.getState().latest?.receiptId === receipt.id) return;
  useAnnouncement.setState({ latest: { threadId, receiptId: receipt.id, text: receipt.content } });
}

/**
 * Persistent status region for revert receipts in the visible thread. It stays
 * mounted and only its text changes, because screen readers skip live regions
 * that mount with content already inside.
 */
export function TurnRevertAnnouncer({ threadId }: { readonly threadId: string }) {
  const latest = useAnnouncement((state) => state.latest);
  // Opening a thread must not replay a receipt announced before it was shown.
  const [baseline, setBaseline] = useState({ threadId, receiptId: latest?.receiptId });
  if (baseline.threadId !== threadId) setBaseline({ threadId, receiptId: latest?.receiptId });
  const fresh = latest?.threadId === threadId && latest.receiptId !== baseline.receiptId;
  return <span role="status" className="sr-only">{fresh ? latest.text : ""}</span>;
}
