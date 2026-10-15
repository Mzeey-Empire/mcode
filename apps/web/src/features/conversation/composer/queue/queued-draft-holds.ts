import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { browserNoteElements, readVisibleBrowserNotePages, removeTakenBrowserNotePages } from "../draft/draft-browser-notes";
import { readVisibleDiffComments, removeTakenDiffComments } from "../draft/draft-diff-comments";
import { readVisibleFileComments, removeTakenFileComments } from "../draft/draft-file-comments";
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

/**
 * The visible draft elements a queued bundle carries, matched by id. Re-queueing an edited
 * message holds exactly these again; anything else visible stays out of the entry.
 */
export function readDraftContentInBundle(
  threadId: string,
  bundle: PreviewAnnotationBundle | undefined,
): FrozenDraftContent {
  const ids = new Set(bundle?.annotations.map((annotation) => annotation.id) ?? []);
  return {
    diffComments: readVisibleDiffComments(threadId).filter((comment) => ids.has(comment.id)),
    fileComments: readVisibleFileComments(threadId).filter((comment) => ids.has(comment.id)),
    browserNotePages: readVisibleBrowserNotePages(threadId)
      .map((page) => ({ ...page, notes: page.notes.filter((note) => ids.has(note.id)) }))
      .filter((page) => page.notes.length > 0),
  };
}

/**
 * Drops the draft copies of the elements a queued bundle carries once every pending admission
 * check settles. An entry re-queued without a hold owns its bundle alone, but a check still
 * running for the entry it replaced can thaw the same elements back into the draft, where a
 * later Send would carry them a second time.
 */
export function dropDraftContentInBundleWhenSettled(
  threadId: string,
  bundle: PreviewAnnotationBundle | undefined,
): void {
  if (!bundle || pendingConfirmations.size === 0) return;
  void Promise.allSettled(pendingConfirmations).then(() => {
    const content = readDraftContentInBundle(threadId, bundle);
    removeTakenBrowserNotePages(threadId, browserNoteElements(content.browserNotePages));
    removeTakenDiffComments(threadId, content.diffComments);
    removeTakenFileComments(threadId, content.fileComments);
  });
}
