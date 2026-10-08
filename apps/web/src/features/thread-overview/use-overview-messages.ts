import { useThreadStore } from "@/stores/threadStore";
import type { Message } from "@mcode/contracts";

/** Stable empty messages reference so the closed Overview never re-renders on new messages. */
const EMPTY_MESSAGES: Message[] = [];

/** Subscribes to source messages only while this overview is open. */
export function useOverviewMessages(threadId: string, open: boolean) {
  return useThreadStore(s => open ? (s.records.get(threadId)?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES);
}
