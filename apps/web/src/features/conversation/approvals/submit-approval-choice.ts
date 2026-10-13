import type { ApprovalRequest, ApprovalRespondResult } from "@mcode/contracts";
import { queueApprovalNote } from "@/features/conversation/composer/queue/queued-approval-note";
import { getTransport } from "@/transport";
import { useApprovalStore } from "@/stores/approvalStore";
import { useThreadStore } from "@/stores/threadStore";

/** Devin's "Switch to Bypass" choice also flips the thread's mode, so later tool calls stop asking. */
const DEVIN_SWITCH_BYPASS_CHOICE_ID = "switch_bypass";

function queueUndeliveredNote(request: ApprovalRequest, note: string, result: ApprovalRespondResult): void {
  if (result.status === "resolved") {
    if (result.noteDelivery === "next_turn") queueApprovalNote(request.threadId, request.requestId, note, "queued");
    if (result.noteDelivery === "unknown") queueApprovalNote(request.threadId, request.requestId, note, "delivery_unknown");
    return;
  }
  if (result.status === "not_pending" && result.note) queueApprovalNote(request.threadId, request.requestId, note, result.note);
}

/**
 * Sends the user's exact choice and settles the request locally once the provider
 * acknowledges it, so the dock advances without waiting for the broadcast.
 */
export async function submitApprovalChoice(request: ApprovalRequest, choiceId: string, note?: string): Promise<void> {
  const store = useApprovalStore.getState();
  const attempt = { choiceId, ...(note ? { note } : {}) };
  store.setSubmission(request.requestId, { ...attempt, state: "submitting" });
  try {
    const result = await getTransport().respondToApproval(request.requestId, attempt);
    if (result.status === "failed") {
      store.setSubmission(request.requestId, { ...attempt, state: "failed" });
      return;
    }
    if (note) queueUndeliveredNote(request, note, result);
    if (result.status === "not_pending") {
      store.remove(request.requestId);
      return;
    }
    store.resolve(request.requestId);
    if (choiceId === DEVIN_SWITCH_BYPASS_CHOICE_ID) {
      void useThreadStore.getState().setThreadSettings(request.threadId, { devinMode: "bypass" });
    }
  } catch {
    store.setSubmission(request.requestId, { ...attempt, state: "failed" });
  }
}
