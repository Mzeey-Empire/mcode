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
 * Delays before asking the server again after a confirmation call failed. A
 * reconnect also retries, but a connection that stays up never reconnects.
 */
const CONFIRMATION_RETRY_DELAYS_MS = [5_000, 30_000];

/** A Send that froze draft elements, settled once by its dispatch outcome. */
export interface DraftSubmissionHandle {
  readonly messageId: string;
  /** Settles after the Send resolved. */
  succeeded(): void;
  /**
   * Settles after the Send threw. The server may still have admitted the
   * message when only its response was lost, so the server confirms it.
   * When the server cannot be reached, the submission stays pending for
   * {@link reconcileOrphanedDraftSubmissions} to settle later.
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
 * Asks the server which of these messages it admitted, or null when it cannot
 * be reached. The server waits for any admission of the id still running, so
 * an absent message is proof the Send failed, never a race with its commit.
 */
async function confirmServerMessages(
  threadId: string,
  messageIds: readonly string[],
): Promise<Set<string> | null> {
  try {
    const results = await Promise.all(messageIds.map(async (messageId) => {
      const { admitted } = await getTransport().confirmMessage(threadId, messageId);
      return admitted ? messageId : null;
    }));
    return new Set(results.filter((messageId): messageId is string => messageId !== null));
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
      const found = await confirmServerMessages(threadId, [messageId]);
      if (!found) {
        inFlightMessageIds.delete(messageId);
        retryReconcileLater(threadId, 0);
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
export async function reconcileOrphanedDraftSubmissions(threadId: string, attempt = 0): Promise<void> {
  const orphaned = (useComposerDraftStore.getState().drafts[threadId]?.submissions ?? [])
    .map((submission) => submission.messageId)
    .filter((messageId) => !inFlightMessageIds.has(messageId));
  if (orphaned.length === 0) return;
  const found = await confirmServerMessages(threadId, orphaned);
  // Unreachable server: keep the submissions pending rather than guess, and look again later.
  if (!found) {
    retryReconcileLater(threadId, attempt);
    return;
  }
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => reconcilePendingSubmissions(
    draft,
    (messageId) => !orphaned.includes(messageId),
    (messageId) => found.has(messageId),
  ));
}

function retryReconcileLater(threadId: string, attempt: number): void {
  const delay = CONFIRMATION_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  setTimeout(() => void reconcileOrphanedDraftSubmissions(threadId, attempt + 1), delay);
}
