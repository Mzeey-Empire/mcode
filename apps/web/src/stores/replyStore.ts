import { create } from "zustand";

/** Per-thread reply state: which message is being replied to and what text is quoted. */
interface ReplyState {
  /** Message ID being replied to, keyed by thread ID. */
  replyByThread: Record<string, {
    messageId: string;
    /** Quoted excerpt for passage-level replies. Undefined for full-message replies. */
    quotedText?: string;
    /** Display preview text (truncated) for the composer chip. */
    previewText: string;
    /** Role of the message being replied to. */
    sourceRole: "user" | "assistant";
  }>;

  /** Set reply context for a thread. */
  setReply: (threadId: string, messageId: string, sourceRole: "user" | "assistant", previewText: string, quotedText?: string) => void;
  /** Clear reply context for a thread. */
  clearReply: (threadId: string) => void;
  /** Get reply context for a thread (or undefined). */
  getReply: (threadId: string) => ReplyState["replyByThread"][string] | undefined;
}

/** Zustand store managing reply-to-message state per thread. */
export const useReplyStore = create<ReplyState>((set, get) => ({
  replyByThread: {},

  setReply: (threadId, messageId, sourceRole, previewText, quotedText) => {
    set((state) => ({
      replyByThread: {
        ...state.replyByThread,
        [threadId]: { messageId, sourceRole, previewText, quotedText },
      },
    }));
  },

  clearReply: (threadId) => {
    set((state) => {
      const replyByThread = { ...state.replyByThread };
      delete replyByThread[threadId];
      return { replyByThread };
    });
  },

  getReply: (threadId) => {
    return get().replyByThread[threadId];
  },
}));
