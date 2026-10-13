import { create } from "zustand";

/** One pending request to scroll a thread's transcript to a message and flash it. */
export interface MessageRevealRequest {
  readonly threadId: string;
  readonly messageId: string;
}

interface MessageRevealState {
  readonly request: MessageRevealRequest | null;
  readonly requestReveal: (threadId: string, messageId: string) => void;
  readonly consume: (request: MessageRevealRequest) => void;
}

/** Lets surfaces outside the transcript, such as a subagent tab, point the chat at a message. */
export const useMessageRevealStore = create<MessageRevealState>((set) => ({
  request: null,
  requestReveal: (threadId, messageId) => set({ request: { threadId, messageId } }),
  consume: (request) => set((state) => (state.request === request ? { request: null } : state)),
}));
