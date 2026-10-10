import type { ApprovalService } from "../../agents/approvals/approval-service.js";
import type { ThreadWaitingSource } from "./thread-attention-service.js";

/** Reads unified approval ownership, including supervised thread operations. */
export function approvalWaitingSource(approvals: Pick<ApprovalService, "listPendingApprovals">): ThreadWaitingSource {
  return {
    kind: "approval",
    listWaiting() {
      const waiting = new Map<string, string>();
      for (const request of approvals.listPendingApprovals()) {
        const since = waiting.get(request.threadId);
        if (since === undefined || request.requestedAt < since) waiting.set(request.threadId, request.requestedAt);
      }
      return waiting;
    },
  };
}
