import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import type { FrozenDraftContent } from "../draft/draft-submission";
import { beginDraftSubmission, type DraftSubmissionHandle } from "../draft/draft-submission-lifecycle";

interface QueuedDraftHold {
  readonly threadId: string;
  readonly handle: DraftSubmissionHandle;
  /** Once dispatched, the server may hold the message even if the entry came back. */
  dispatched: boolean;
}

/** Draft holds keyed by the id of the queue entry that owns them. */
const holds = new Map<string, QueuedDraftHold>();
/** Confirmations still asking the server whether a dropped, already dispatched entry was admitted. */
const pendingConfirmations = new Set<Promise<void>>();
let unsubscribe: (() => void) | null = null;

type QueueSnapshot = Pick<
  ReturnType<typeof useQueueStore.getState>,
  "queues" | "inFlightQueuedMessages" | "disposedQueuedMessages"
>;

function isQueued(state: QueueSnapshot, threadId: string, messageId: string): boolean {
  return (state.queues[threadId] ?? []).some((message) => message.id === messageId);
}

function isDispatching(state: QueueSnapshot, threadId: string, messageId: string): boolean {
  return state.inFlightQueuedMessages[threadId]?.message.id === messageId
    || (state.disposedQueuedMessages[threadId] ?? []).some((lease) => lease.message.id === messageId);
}

/**
 * Releases every hold whose entry left the queue without being admitted. Watching the store
 * catches removal, Clear all, thread deletion, a disposed lease and an edit pop alike, so no
 * call site can drop an entry and strand its elements.
 */
function releaseDroppedHolds(state: QueueSnapshot): void {
  for (const [messageId, hold] of holds) {
    if (isDispatching(state, hold.threadId, messageId)) {
      hold.dispatched = true;
      continue;
    }
    if (isQueued(state, hold.threadId, messageId)) continue;
    holds.delete(messageId);
    if (hold.dispatched) trackConfirmation(hold.handle.failed());
    else hold.handle.released();
  }
  if (holds.size === 0) stopWatching();
}

function trackConfirmation(confirmation: Promise<void>): void {
  const tracked = confirmation.finally(() => pendingConfirmations.delete(tracked));
  pendingConfirmations.add(tracked);
}

function startWatching(): void {
  unsubscribe ??= useQueueStore.subscribe(releaseDroppedHolds);
}

function stopWatching(): void {
  unsubscribe?.();
  unsubscribe = null;
}

function carriesElements(content: FrozenDraftContent): boolean {
  return content.diffComments.length > 0
    || content.fileComments.length > 0
    || content.browserNotePages.length > 0;
}

/**
 * Queues a message and holds the draft elements it carries under the entry's id, which is
 * also the id it dispatches with. The elements stay in the persisted draft, hidden, until
 * the server admits the message or the entry leaves the queue, so a reload loses neither.
 * Returns false, holding nothing, when the queue is full.
 */
export function queueHoldingDraftElements(
  threadId: string,
  payload: Omit<QueuedMessage, "id" | "queuedAt">,
  content: FrozenDraftContent,
  index?: number,
): boolean {
  const id = crypto.randomUUID();
  const { holdsDraftElements: _previous, ...plain } = payload;
  const entry = carriesElements(content) ? { ...plain, holdsDraftElements: true as const } : plain;
  const handle = beginDraftSubmission(threadId, content, id);
  const queue = useQueueStore.getState();
  const queued = index === undefined ? queue.enqueue(threadId, entry, id) : queue.insertAt(threadId, index, entry, id);
  if (!queued) {
    handle?.released();
    return false;
  }
  if (handle) {
    holds.set(id, { threadId, handle, dispatched: false });
    startWatching();
  }
  return true;
}

/**
 * Settles a queued message's hold once the server admitted it. Runs before the lease
 * settles, so the watcher never mistakes the admitted entry for a dropped one.
 */
export function admitQueuedDraftHold(messageId: string): void {
  const hold = holds.get(messageId);
  if (!hold) return;
  holds.delete(messageId);
  hold.handle.succeeded();
  if (holds.size === 0) stopWatching();
}

/** Resolves once every admission check now running for a dropped entry has an answer. */
export function whenAdmissionChecksSettle(): Promise<unknown> {
  return Promise.allSettled(pendingConfirmations);
}
