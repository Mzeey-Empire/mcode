import { create } from "zustand";
import type { AttachmentMeta, PermissionMode } from "@/transport";
import type {
  ApprovalReviewMode,
  ContextWindowMode,
  DevinMode,
  MessageMention,
  PreviewAnnotationBundle,
  ReasoningLevel,
  OrchestrationMode,
} from "@mcode/contracts";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";

/**
 * A queued message's steer into a running turn, while it is unsettled. The provider may
 * already hold a `steering` or `delivery_unknown` message, so neither is ever sent again on
 * its own; a `resend` is an ordinary queued turn whose id is the server's replacement id.
 * `settling` holds a held item while the server settles it, and remembers what to restore.
 */
export type QueuedSteer =
  | { readonly state: "steering"; readonly steerId: string; readonly turnExecutionId: string }
  | { readonly state: "delivery_unknown"; readonly steerId: string }
  | { readonly state: "resend"; readonly resendOfSteerId: string }
  | {
    readonly state: "settling";
    readonly steerId: string;
    readonly previous: Extract<QueuedSteer, { state: "delivery_unknown" | "resend" }>;
  };

/**
 * A deny note the server holds for this item until turn admission claims it. A `queued` note
 * sends like any queued message but never steers, because only admission claims it once.
 * Mcode cannot tell whether the provider took a `delivery_unknown` note, so it waits for the
 * user. `settling` holds the item while the server answers Send again or Remove.
 */
export interface QueuedApprovalNote {
  readonly requestId: string;
  readonly state: "queued" | "delivery_unknown" | "settling";
}

/** A message waiting to be sent while the thread is busy with another turn. */
export interface QueuedMessage {
  id: string;
  content: string;
  /** Optional display-only variant of content (e.g. stripped of internal markup). */
  displayContent?: string;
  /** Selected typed mentions with offsets into content. Plain typed @text is not included. */
  mentions?: MessageMention[];
  /** Saved preview annotations to send with the queued message. */
  previewAnnotations?: PreviewAnnotationBundle;
  attachments: AttachmentMeta[];
  model: string;
  permissionMode: PermissionMode;
  approvalReviewMode?: ApprovalReviewMode;
  /** Reasoning effort level to apply when the message is sent. */
  reasoningLevel?: ReasoningLevel;
  /** Provider-native proactive delegation mode for this queued turn. */
  orchestrationMode?: OrchestrationMode;
  /** Provider to use; undefined means inherit the thread's stored provider. */
  provider?: string;
  /** Claude context window mode for this turn; undefined means inherit from thread/settings. */
  contextWindow?: ContextWindowMode;
  /** Haiku thinking toggle for this turn; undefined means inherit from thread/settings. */
  thinking?: boolean;
  /** Codex OpenAI fast tier for this queued send; undefined inherits at dequeue. */
  codexFastMode?: boolean;
  /** Devin native mode for this queued send; undefined inherits at dequeue. */
  devinMode?: DevinMode;
  /** Goal objective installed atomically when this queued turn dispatches. */
  goalObjective?: string;
  /** Preview spill paths to unlink when this item is permanently removed from the queue. */
  browserCaptureSpillPaths?: string[];
  /** Unix timestamp (ms) when this message was enqueued. */
  queuedAt: number;
  /** Present while a steer of this message is unsettled or it is the resend of one. */
  steer?: QueuedSteer;
  /** Present when this item is a deny note the server holds. */
  approvalNote?: QueuedApprovalNote;
}

/** True while the provider may hold this message, so the dispatcher must not send it. */
export function isHeldQueuedMessage(message: QueuedMessage): boolean {
  const state = message.steer?.state;
  const noteState = message.approvalNote?.state;
  return state === "steering" || state === "delivery_unknown" || state === "settling"
    || noteState === "delivery_unknown" || noteState === "settling";
}

/** True when Mcode cannot tell whether the provider took this message's steer or deny note. */
export function isDeliveryUnknown(message: QueuedMessage): boolean {
  return message.steer?.state === "delivery_unknown" || message.approvalNote?.state === "delivery_unknown";
}

const MAX_QUEUE_DEPTH = 20;

interface QueuedDispatchLease {
  message: QueuedMessage;
  index: number;
  generation: number;
}

interface QueueState {
  /** Per-thread message queues. */
  queues: Record<string, QueuedMessage[]>;
  /** A claimed queued message that remains queue-owned until transport settles. */
  inFlightQueuedMessages: Record<string, QueuedDispatchLease | undefined>;
  /** Removed leases retained only until their transport call settles and spills can be released safely. */
  disposedQueuedMessages: Record<string, QueuedDispatchLease[]>;
  /** Incremented by Clear all or deletion so a failed lease cannot recreate a removed queue. */
  queueGenerations: Record<string, number>;
  /** Threads whose queued messages require an explicit Continue before automatic drain resumes. */
  autoDrainSuppressedThreadIds: Set<string>;
  /** Toast text shown briefly after enqueue. Null when hidden. */
  toast: string | null;
  /**
   * Thread ID whose queue is currently frozen because the user is editing
   * a message in the composer. Auto-drain skips this thread until the edit
   * is saved or cancelled.
   */
  editingThreadId: string | null;

  /** Mark a thread as having an in-progress queue edit (or clear it). */
  setEditingThreadId: (threadId: string | null) => void;
  enqueue: (
    threadId: string,
    message: Omit<QueuedMessage, "id" | "queuedAt">,
  ) => boolean;
  /** Atomically reserve the next visible message for one queued send, skipping held steers. */
  claimNextQueuedMessage: (threadId: string) => QueuedMessage | undefined;
  /** Atomically reserve one visible message for Send now. A held steer cannot be claimed. */
  claimQueuedMessage: (threadId: string, messageId: string) => QueuedMessage | undefined;
  /** Commit an accepted queued send or restore a failed lease at its original FIFO position. */
  settleQueuedDispatch: (threadId: string, messageId: string, accepted: boolean) => void;
  /** Block automatic drain until the user explicitly continues this thread. */
  suppressAutoDrain: (threadId: string) => void;
  /** Allow automatic drain after an explicit Continue. */
  resumeAutoDrain: (threadId: string) => void;
  removeFromQueue: (threadId: string, messageId: string) => void;
  clearQueue: (threadId: string) => void;
  /**
   * Rewrite the content (and optional display variant) of a queued message
   * without changing its position or other metadata. No-op if the message
   * is no longer in the queue.
   */
  editMessage: (
    threadId: string,
    messageId: string,
    content: string,
    displayContent?: string,
    mentions?: MessageMention[],
  ) => void;
  /** Record a steer's progress on a queued message; `steer: undefined` returns it to the plain queue. */
  setQueuedSteer: (threadId: string, messageId: string, steer: QueuedSteer | undefined) => void;
  /**
   * Turn a delivery-unknown item into the queued resend Send again stored. The item takes the
   * replacement id; when another copy already holds that id, this one is dropped.
   */
  requeueAsResend: (threadId: string, steerId: string, replacementMessageId: string) => void;
  /** Append a held steer the server reported and this window has no copy of. */
  adoptHeldSteer: (threadId: string, message: QueuedMessage) => void;
  /**
   * Add a deny note, or update the state of the item that already holds it. Nothing changes
   * while that item is settling or out for sending, since those answers decide it.
   */
  upsertApprovalNote: (threadId: string, message: QueuedMessage & { approvalNote: QueuedApprovalNote }) => void;
  /** Record a held deny note's state on its queue item. */
  setApprovalNoteState: (threadId: string, messageId: string, state: QueuedApprovalNote["state"]) => void;
  /**
   * Remove a specific queued message and return it. Used by the queue editor
   * while it prepares the edited replacement.
   * Does NOT release browser-capture spills (the caller is sending the
   * message and still owns them).
   */
  popMessage: (threadId: string, messageId: string) => QueuedMessage | undefined;
  /**
   * Insert a message at a specific index (clamped). Used when the user
   * saves an edit pulled out via `popMessage` - the edited message goes
   * back to the same slot it was extracted from, instead of being appended
   * to the tail by `enqueue`. Honours the {@link MAX_QUEUE_DEPTH} cap.
   * Returns false when the queue is full (caller may release spills).
   */
  insertAt: (
    threadId: string,
    index: number,
    message: Omit<QueuedMessage, "id" | "queuedAt">,
  ) => boolean;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(set: (partial: Partial<QueueState>) => void, text: string) {
  if (toastTimer) clearTimeout(toastTimer);
  set({ toast: text });
  toastTimer = setTimeout(() => set({ toast: null }), 1800);
}

function queueDepth(state: Pick<QueueState, "queues" | "inFlightQueuedMessages">, threadId: string): number {
  return (state.queues[threadId]?.length ?? 0) + (state.inFlightQueuedMessages[threadId] ? 1 : 0);
}

function settleDisposedQueuedMessage(
  state: QueueState,
  threadId: string,
  messageId: string,
  accepted: boolean,
): { patch: Partial<QueueState>; releasePaths?: string[] } | null {
  const disposed = state.disposedQueuedMessages[threadId] ?? [];
  const index = disposed.findIndex((item) => item.message.id === messageId);
  if (index === -1) return null;
  const disposedQueuedMessages = { ...state.disposedQueuedMessages };
  const remaining = disposed.filter((_, itemIndex) => itemIndex !== index);
  if (remaining.length === 0) delete disposedQueuedMessages[threadId];
  else disposedQueuedMessages[threadId] = remaining;
  return {
    patch: { disposedQueuedMessages },
    ...(!accepted ? { releasePaths: disposed[index].message.browserCaptureSpillPaths } : {}),
  };
}

function settleActiveQueuedMessage(
  state: QueueState,
  threadId: string,
  messageId: string,
  accepted: boolean,
): { patch: Partial<QueueState>; releasePaths?: string[] } | null {
  const lease = state.inFlightQueuedMessages[threadId];
  if (!lease || lease.message.id !== messageId) return null;
  const inFlightQueuedMessages = { ...state.inFlightQueuedMessages };
  delete inFlightQueuedMessages[threadId];
  if (accepted) return { patch: { inFlightQueuedMessages } };
  if (lease.generation !== (state.queueGenerations[threadId] ?? 0)) {
    return { patch: { inFlightQueuedMessages }, releasePaths: lease.message.browserCaptureSpillPaths };
  }
  const messages = [...(state.queues[threadId] ?? [])];
  messages.splice(Math.min(lease.index, messages.length), 0, lease.message);
  return {
    patch: {
      inFlightQueuedMessages,
      queues: { ...state.queues, [threadId]: messages },
      autoDrainSuppressedThreadIds: new Set(state.autoDrainSuppressedThreadIds).add(threadId),
    },
  };
}

/**
 * Zustand store managing per-thread message queues.
 *
 * Messages are enqueued when the agent is busy and drained FIFO when the
 * turn completes. Supports reorder, edit-in-place, pop-for-send-now, and
 * an editing lock that pauses auto-drain while a message is open in the composer.
 */
export const useQueueStore = create<QueueState>((set, get) => ({
  queues: {},
  inFlightQueuedMessages: {},
  disposedQueuedMessages: {},
  queueGenerations: {},
  autoDrainSuppressedThreadIds: new Set<string>(),
  toast: null,
  editingThreadId: null,

  setEditingThreadId: (threadId) => set({ editingThreadId: threadId }),

  enqueue: (threadId, message) => {
    const state = get();
    if (queueDepth(state, threadId) >= MAX_QUEUE_DEPTH) {
      showToast(set, "Queue full");
      return false;
    }

    const entry: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      queuedAt: Date.now(),
    };

    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: [...(state.queues[threadId] ?? []), entry],
      },
    }));

    return true;
  },

  claimNextQueuedMessage: (threadId) => {
    const current = get().queues[threadId] ?? [];
    const next = current.find((message) => !isHeldQueuedMessage(message));
    return get().claimQueuedMessage(threadId, next?.id ?? "");
  },

  claimQueuedMessage: (threadId, messageId) => {
    const state = get();
    if (state.inFlightQueuedMessages[threadId]) return undefined;
    const current = state.queues[threadId] ?? [];
    const index = current.findIndex((message) => message.id === messageId);
    if (index === -1) return undefined;
    const message = current[index];
    if (isHeldQueuedMessage(message)) return undefined;
    set((latest) => {
      if (latest.inFlightQueuedMessages[threadId]) return latest;
      const messages = latest.queues[threadId] ?? [];
      const currentIndex = messages.findIndex((item) => item.id === messageId);
      if (currentIndex === -1) return latest;
      return {
        queues: { ...latest.queues, [threadId]: messages.filter((item) => item.id !== messageId) },
        inFlightQueuedMessages: {
          ...latest.inFlightQueuedMessages,
          [threadId]: {
            message: messages[currentIndex],
            index: currentIndex,
            generation: latest.queueGenerations[threadId] ?? 0,
          },
        },
      };
    });
    return get().inFlightQueuedMessages[threadId]?.message.id === message.id ? message : undefined;
  },

  settleQueuedDispatch: (threadId, messageId, accepted) => {
    let releasePaths: string[] | undefined;
    set((state) => {
      const settled = settleDisposedQueuedMessage(state, threadId, messageId, accepted)
        ?? settleActiveQueuedMessage(state, threadId, messageId, accepted);
      if (!settled) return state;
      releasePaths = settled.releasePaths;
      return settled.patch;
    });
    if (releasePaths?.length) void releaseBrowserCaptureSpills(releasePaths);
  },

  suppressAutoDrain: (threadId) => {
    set((state) => {
      if (state.autoDrainSuppressedThreadIds.has(threadId)) return state;
      return { autoDrainSuppressedThreadIds: new Set([...state.autoDrainSuppressedThreadIds, threadId]) };
    });
  },

  resumeAutoDrain: (threadId) => {
    set((state) => {
      if (!state.autoDrainSuppressedThreadIds.has(threadId)) return state;
      const autoDrainSuppressedThreadIds = new Set(state.autoDrainSuppressedThreadIds);
      autoDrainSuppressedThreadIds.delete(threadId);
      return { autoDrainSuppressedThreadIds };
    });
  },

  removeFromQueue: (threadId, messageId) => {
    const current = get().queues[threadId] ?? [];
    const msg = current.find((m) => m.id === messageId);
    if (msg?.browserCaptureSpillPaths?.length) {
      void releaseBrowserCaptureSpills(msg.browserCaptureSpillPaths);
    }
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: (state.queues[threadId] ?? []).filter((m) => m.id !== messageId),
      },
    }));
  },

  clearQueue: (threadId) => {
    const list = get().queues[threadId] ?? [];
    const paths = list.flatMap((m) => m.browserCaptureSpillPaths ?? []);
    if (paths.length > 0) void releaseBrowserCaptureSpills(paths);
    set((state) => {
      const next = { ...state.queues };
      delete next[threadId];
      const inFlightQueuedMessages = { ...state.inFlightQueuedMessages };
      const activeLease = inFlightQueuedMessages[threadId];
      delete inFlightQueuedMessages[threadId];
      const disposedQueuedMessages = activeLease
        ? {
            ...state.disposedQueuedMessages,
            [threadId]: [...(state.disposedQueuedMessages[threadId] ?? []), activeLease],
          }
        : state.disposedQueuedMessages;
      const queueGenerations = {
        ...state.queueGenerations,
        [threadId]: (state.queueGenerations[threadId] ?? 0) + 1,
      };
      const autoDrainSuppressedThreadIds = new Set(state.autoDrainSuppressedThreadIds);
      autoDrainSuppressedThreadIds.delete(threadId);
      return {
        queues: next,
        inFlightQueuedMessages,
        disposedQueuedMessages,
        queueGenerations,
        autoDrainSuppressedThreadIds,
      };
    });
  },

  editMessage: (threadId, messageId, content, displayContent, mentions) => {
    set((state) => {
      const current = state.queues[threadId];
      if (!current) return state;
      const idx = current.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;
      const updated: QueuedMessage = {
        ...current[idx],
        content,
        displayContent: displayContent ?? content,
        mentions,
      };
      const nextList = [...current];
      nextList[idx] = updated;
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  setQueuedSteer: (threadId, messageId, steer) => {
    set((state) => {
      const current = state.queues[threadId];
      const index = current?.findIndex((message) => message.id === messageId) ?? -1;
      if (!current || index === -1) return state;
      const { steer: _previous, ...plain } = current[index];
      void _previous;
      const nextList = [...current];
      nextList[index] = steer ? { ...plain, steer } : plain;
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  requeueAsResend: (threadId, steerId, replacementMessageId) => {
    set((state) => {
      const current = state.queues[threadId] ?? [];
      const index = current.findIndex((message) => message.steer?.state === "delivery_unknown"
        && message.steer.steerId === steerId);
      if (index === -1) return state;
      const leased = state.inFlightQueuedMessages[threadId]?.message.id === replacementMessageId;
      const duplicate = leased || current.some((message) => message.id === replacementMessageId);
      const nextList = duplicate
        ? current.filter((_, itemIndex) => itemIndex !== index)
        : current.map((message, itemIndex) => itemIndex === index
          ? { ...message, id: replacementMessageId, steer: { state: "resend", resendOfSteerId: steerId } as const }
          : message);
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  adoptHeldSteer: (threadId, message) => {
    set((state) => {
      const current = state.queues[threadId] ?? [];
      if (current.some((item) => item.id === message.id)) return state;
      if (state.inFlightQueuedMessages[threadId]?.message.id === message.id) return state;
      return { queues: { ...state.queues, [threadId]: [...current, message] } };
    });
  },

  upsertApprovalNote: (threadId, message) => {
    set((state) => {
      const requestId = message.approvalNote.requestId;
      if (state.inFlightQueuedMessages[threadId]?.message.approvalNote?.requestId === requestId) return state;
      const current = state.queues[threadId] ?? [];
      const index = current.findIndex((item) => item.approvalNote?.requestId === requestId);
      if (index === -1) return { queues: { ...state.queues, [threadId]: [...current, message] } };
      if (current[index].approvalNote?.state === "settling") return state;
      const nextList = [...current];
      nextList[index] = { ...current[index], approvalNote: message.approvalNote };
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  setApprovalNoteState: (threadId, messageId, noteState) => {
    set((state) => {
      const current = state.queues[threadId];
      const index = current?.findIndex((message) => message.id === messageId) ?? -1;
      const note = current?.[index]?.approvalNote;
      if (!current || !note) return state;
      const nextList = [...current];
      nextList[index] = { ...current[index], approvalNote: { ...note, state: noteState } };
      return { queues: { ...state.queues, [threadId]: nextList } };
    });
  },

  popMessage: (threadId, messageId) => {
    const current = get().queues[threadId];
    if (!current) return undefined;
    const msg = current.find((m) => m.id === messageId);
    if (!msg) return undefined;
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: (state.queues[threadId] ?? []).filter((m) => m.id !== messageId),
      },
    }));
    return msg;
  },

  insertAt: (threadId, index, message) => {
    const state = get();
    const current = state.queues[threadId] ?? [];
    if (queueDepth(state, threadId) >= MAX_QUEUE_DEPTH) {
      showToast(set, "Queue full");
      return false;
    }
    const clamped = Math.max(0, Math.min(index, current.length));
    const entry: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      queuedAt: Date.now(),
    };
    const nextList = [...current];
    nextList.splice(clamped, 0, entry);
    set((state) => ({
      queues: { ...state.queues, [threadId]: nextList },
    }));
    return true;
  },
}));
