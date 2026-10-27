import { describe, expect, it } from "vitest";
import { ApprovalDecidedPayloadSchema } from "@mcode/contracts/models/approval-receipt";
import { type ApprovalOutcome, type ApprovalRequestEnvelope, type ApprovalSubject } from "@mcode/contracts/models/approval";
import { approvalReceipt } from "../approval-receipt.js";

function request(subject: ApprovalSubject): ApprovalRequestEnvelope {
  return {
    requestId: "request-1", threadId: "thread-1",
    body: {
      toolCallId: "tool-1", requestedAt: "2026-10-10T12:00:00.000Z", subject,
      choices: [{ id: "deny", intent: "deny", label: "Reject always" }],
      origin: { kind: "agent" },
    },
  };
}

describe("approvalReceipt", () => {
  it.each<[ApprovalSubject, string]>([
    [{ kind: "command", command: "git status" }, "git status"],
    [{ kind: "command", command: "x".repeat(201) }, "x".repeat(200)],
    [{ kind: "file_edit", files: [{ path: "C:\\fixture\\main.ts", change: "edited", additions: 1, deletions: 0 }] }, "main.ts"],
    [{ kind: "fetch", url: "https://example.com/private?token=secret" }, "example.com"],
    [{ kind: "tool", toolName: "search" }, "search"],
    [{ kind: "delegate_task", taskId: "task-1", title: "Review startup cancellation", providerId: "codex", modelId: "gpt-test", isolation: "worktree" }, "Review startup cancellation"],
  ])("builds a bounded subject label for %j", (subject, subjectLabel) => {
    const receipt = approvalReceipt(request(subject), { status: "denied", choiceLabel: "Reject always" });
    expect(receipt).toEqual({
      type: "approvalDecided", requestId: "request-1", threadId: "thread-1", toolCallId: "tool-1",
      kind: subject.kind, subjectLabel, origin: { kind: "agent" },
      outcome: { status: "denied", choiceLabel: "Reject always" },
    });
    expect(ApprovalDecidedPayloadSchema().safeParse(receipt).success).toBe(true);
  });

  it.each<ApprovalOutcome>([
    { status: "auto_denied", reason: "too_large" },
    { status: "cancelled", reason: "unanswerable" },
  ])("never exposes failed-closed bodies for %j", (outcome) => {
    expect(approvalReceipt({ requestId: "request-1", threadId: "thread-1", body: "private unreadable data" }, outcome)).toEqual({
      type: "approvalDecided", requestId: "request-1", threadId: "thread-1", kind: "tool",
      subjectLabel: "Mcode couldn't read this request", outcome,
    });
  });
});
