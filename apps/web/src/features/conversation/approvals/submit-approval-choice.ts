import type { ApprovalAnswers, ApprovalRequest } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useApprovalStore } from "@/stores/approvalStore";
import { useThreadStore } from "@/stores/threadStore";

/** Devin's "Switch to Bypass" choice also flips the thread's mode, so later tool calls stop asking. */
const DEVIN_SWITCH_BYPASS_CHOICE_ID = "switch_bypass";

/**
 * Sends the user's exact choice and settles the request locally once the provider
 * acknowledges it, so the dock advances without waiting for the broadcast. A question
 * request carries its `answers` with the allowing choice.
 */
export async function submitApprovalChoice(request: ApprovalRequest, choiceId: string, answers?: ApprovalAnswers): Promise<void> {
  const store = useApprovalStore.getState();
  store.setSubmission(request.requestId, { choiceId, state: "submitting" });
  try {
    const result = await getTransport().respondToApproval(request.requestId, { choiceId, ...(answers ? { answers } : {}) });
    if (result.status === "failed") {
      store.setSubmission(request.requestId, { choiceId, state: "failed" });
      return;
    }
    if (result.status === "not_pending") {
      store.remove(request.requestId);
      return;
    }
    store.resolve(request.requestId);
    if (choiceId === DEVIN_SWITCH_BYPASS_CHOICE_ID) {
      void useThreadStore.getState().setThreadSettings(request.threadId, { devinMode: "bypass" });
    }
  } catch {
    store.setSubmission(request.requestId, { choiceId, state: "failed" });
  }
}
