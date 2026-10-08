import type { DraftDiffComment } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import {
  freezeDraftSubmission,
  reconcilePendingSubmissions,
  settleDraftSubmission,
} from "./draft-submission";

/** Sends this window started that have not settled; only these skip reconcile. */
const inFlightMessageIds = new Set<string>();

/**
 * Delays before re-reading the thread after a confirmation read failed. A
 * reconnect also retries, but a connection that stays up never reconnects.
 */
const CONFIRMATION_RETRY_DELAYS_MS = [5_000, 30_000];

/** Page size for confirming a lost or interrupted Send; a fresh Send is usually on the first page. */
const CONFIRMATION_PAGE_SIZE = 100;

/** A Send that froze draft elements, settled once by its dispatch outcome. */
export interface DraftSubmissionHandle {
  readonly messageId: string;
  /** Settles after the Send resolved. */
  succeeded(): void;
  /**
   * Settles after the Send threw. The server may still have admitted the
   * message when only its response was lost, so its message list decides.
   * When the server cannot be read either, the submission stays pending for
   * {@link reconcileOrphanedDraftSubmissions} to settle after reconnect.
   */
  failed(): Promise<void>;
}

function settle(threadId: string, messageId: string, outcome: "success" | "failure"): void {
  inFlightMessageIds.delete(messageId);
  useComposerDraftStore.getState().updateNextMessage(
    threadId,
    (draft) => settleDraftSubmission(draft, messageId, outcome),
  );
}

/**
 * Reports which of the given message ids the server holds for a thread, or
 * null when the server cannot be read. Pages back through the whole history
 * only while some id is still unfound, because absence must be proven before
 * a Send's elements return.
 */
async function findServerMessages(
  threadId: string,
  messageIds: readonly string[],
): Promise<Set<string> | null> {
  const wanted = new Set(messageIds);
  const found = new Set<string>();
  let before: number | undefined;
  try {
    for (;;) {
      const page = await getTransport().getMessages(threadId, CONFIRMATION_PAGE_SIZE, before);
      for (const message of page.messages) {
        if (wanted.has(message.id)) found.add(message.id);
      }
      const oldest = page.messages[0];
      if (found.size === wanted.size || !page.hasMore || !oldest) return found;
      before = oldest.sequence;
    }
  } catch {
    return null;
  }
}

/**
 * Freezes the Review comment revisions a Send carries. Returns null when the
 * Send carries none, so plain messages skip the draft entirely.
 */
export function beginDraftSubmission(
  threadId: string | undefined,
  diffComments: readonly DraftDiffComment[],
  messageId: string,
): DraftSubmissionHandle | null {
  if (!threadId || diffComments.length === 0) return null;
  inFlightMessageIds.add(messageId);
  useComposerDraftStore.getState().updateNextMessage(
    threadId,
    (draft) => freezeDraftSubmission(draft, messageId, { diffComments }).draft,
  );
  return {
    messageId,
    succeeded: () => settle(threadId, messageId, "success"),
    failed: async () => {
      const found = await findServerMessages(threadId, [messageId]);
      if (!found) {
        inFlightMessageIds.delete(messageId);
        for (const delay of CONFIRMATION_RETRY_DELAYS_MS) {
          setTimeout(() => void reconcileOrphanedDraftSubmissions(threadId), delay);
        }
        return;
      }
      settle(threadId, messageId, found.has(messageId) ? "success" : "failure");
    },
  };
}

/**
 * Settles submissions left pending by an earlier session. A thread holding
 * the message means it was admitted; otherwise every element returns.
 */
export async function reconcileOrphanedDraftSubmissions(threadId: string): Promise<void> {
  const orphaned = (useComposerDraftStore.getState().drafts[threadId]?.submissions ?? [])
    .map((submission) => submission.messageId)
    .filter((messageId) => !inFlightMessageIds.has(messageId));
  if (orphaned.length === 0) return;
  const found = await findServerMessages(threadId, orphaned);
  // Unreachable server: keep the submissions pending rather than guess.
  if (!found) return;
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => reconcilePendingSubmissions(
    draft,
    (messageId) => !orphaned.includes(messageId),
    (messageId) => found.has(messageId),
  ));
}
