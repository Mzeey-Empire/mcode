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

/** Recent messages read to confirm a lost or interrupted Send; a fresh Send sits at the tail. */
const CONFIRMATION_WINDOW = 50;

/** A Send that froze draft elements, settled once by its dispatch outcome. */
export interface DraftSubmissionHandle {
  readonly messageId: string;
  /** Settles after the Send resolved. */
  succeeded(): void;
  /**
   * Settles after the Send threw. The server may still have admitted the
   * message when only its response was lost, so its message list decides.
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

async function readServerMessageIds(threadId: string): Promise<Set<string> | null> {
  try {
    const page = await getTransport().getMessages(threadId, CONFIRMATION_WINDOW);
    return new Set(page.messages.map((message) => message.id));
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
      const serverIds = await readServerMessageIds(threadId);
      settle(threadId, messageId, serverIds?.has(messageId) ? "success" : "failure");
    },
  };
}

/**
 * Settles submissions left pending by an earlier session. A thread holding
 * the message means it was admitted; otherwise every element returns.
 */
export async function reconcileOrphanedDraftSubmissions(threadId: string): Promise<void> {
  const pending = useComposerDraftStore.getState().drafts[threadId]?.submissions ?? [];
  if (!pending.some((submission) => !inFlightMessageIds.has(submission.messageId))) return;
  const serverIds = await readServerMessageIds(threadId);
  // Unreachable server: keep the submissions pending rather than guess.
  if (!serverIds) return;
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => reconcilePendingSubmissions(
    draft,
    (messageId) => inFlightMessageIds.has(messageId),
    (messageId) => serverIds.has(messageId),
  ));
}
