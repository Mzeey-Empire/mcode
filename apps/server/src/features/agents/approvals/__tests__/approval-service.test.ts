import "reflect-metadata";
import * as NodeEvents from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestEnvelope, ApprovalResponse, ApprovalRespondResult, ApprovalRequestBody } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { ApprovalService, UNREADABLE_APPROVAL_TITLE } from "../approval-service.js";

vi.mock("@mcode/shared", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const body: ApprovalRequestBody = {
  requestedAt: "2026-10-10T10:00:00Z", subject: { kind: "command", command: "bun run lint" },
  choices: [{ id: "allow", intent: "allow_once", label: "Allow once" },
    { id: "reject_once", intent: "deny", label: "Reject once" }, { id: "reject_always", intent: "deny", label: "Reject always" }],
  noteDelivery: "next_turn", noteChoiceId: "reject_once", origin: { kind: "agent" },
};

class FakeProvider extends NodeEvents.EventEmitter {
  readonly id = "cursor" as const;
  pending: ApprovalRequestEnvelope[] = [];
  readonly resolveApproval = vi.fn<(requestId: string, response: ApprovalResponse) => Promise<ApprovalRespondResult>>();
  listPendingApprovals(threadId?: string): ApprovalRequestEnvelope[] {
    return this.pending.filter((request) => threadId === undefined || request.threadId === threadId);
  }
}

function setup() {
  const provider = new FakeProvider();
  const publishApprovalRequest = vi.fn();
  const publishApprovalResolved = vi.fn();
  const stopSession = vi.fn(async () => { provider.pending = []; });
  const service = new ApprovalService({ resolveAll: () => [provider] });
  service.start({ publishApprovalRequest, publishApprovalResolved, stopSession });
  return { provider, service, publishApprovalRequest, publishApprovalResolved, stopSession };
}

beforeEach(() => vi.clearAllMocks());

describe("ApprovalService", () => {
  it("does not report automatic denial before the native acknowledgement and never logs payload values", async () => {
    const test = setup();
    const delivery = Promise.withResolvers<ApprovalRespondResult>();
    test.provider.resolveApproval.mockReturnValue(delivery.promise);
    test.provider.emit("approval_request", { requestId: "bad", threadId: "owner", body: { subject: "secret-payload" } });
    await vi.waitFor(() => expect(test.provider.resolveApproval.mock.calls).toEqual([["bad", { autoDeny: "unreadable" }]]));
    expect(test.publishApprovalResolved.mock.calls).toEqual([]);
    expect(test.publishApprovalRequest.mock.calls[0]?.[0].subject).toEqual({ kind: "tool", toolName: UNREADABLE_APPROVAL_TITLE });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("secret-payload");
    expect(vi.mocked(logger.warn).mock.calls[0]?.[1]).toMatchObject({ providerId: "cursor", requestId: "bad" });
    delivery.resolve({ status: "resolved" });
    await vi.waitFor(() => expect(test.publishApprovalResolved.mock.calls).toEqual([[{
      requestId: "bad", threadId: "owner", outcome: { status: "auto_denied", reason: "unreadable" },
    }]]));
    expect(test.stopSession.mock.calls).toEqual([]);
  });

  it.each(["failed", "throws"])("stops the owner when automatic denial %s", async (mode) => {
    const test = setup();
    test.provider.pending = [{ requestId: "bad", threadId: "owner", body: null }];
    if (mode === "throws") test.provider.resolveApproval.mockRejectedValue(new Error("private-native-error"));
    else test.provider.resolveApproval.mockResolvedValue({ status: "failed", message: "offline" });
    expect(test.service.listPendingApprovals()).toEqual([]);
    await vi.waitFor(() => expect(test.publishApprovalResolved.mock.calls).toEqual([[{
      requestId: "bad", threadId: "owner", outcome: { status: "cancelled", reason: "unanswerable" },
    }]]));
    expect(test.stopSession.mock.calls).toEqual([["owner"]]);
    expect(test.provider.pending).toEqual([]);
  });

  it.each([
    { ...body, choices: [{ id: "allow", intent: "allow_once", label: "Allow" }] },
    { ...body, noteChoiceId: undefined },
    { ...body, noteChoiceId: "allow" },
    { ...body, choices: [...body.choices, { id: "allow", intent: "deny", label: "Deny" }] },
  ])("rejects unusable choice sets during publication and listing", async (invalid) => {
    const test = setup();
    const delivery = Promise.withResolvers<ApprovalRespondResult>();
    test.provider.resolveApproval.mockReturnValue(delivery.promise);
    const envelope = { requestId: "bad", threadId: "owner", body: invalid };
    test.provider.pending = [envelope];
    test.provider.emit("approval_request", envelope);
    expect(test.service.listPendingApprovals()).toEqual([]);
    await vi.waitFor(() => expect(test.provider.resolveApproval.mock.calls).toEqual([["bad", { autoDeny: "unreadable" }]]));
    expect(test.publishApprovalRequest.mock.calls.map(([request]) => request.subject)).toEqual([{ kind: "tool", toolName: UNREADABLE_APPROVAL_TITLE }]);
    delivery.resolve({ status: "resolved" });
    await vi.waitFor(() => expect(test.publishApprovalResolved.mock.calls).toEqual([[{
      requestId: "bad", threadId: "owner", outcome: { status: "auto_denied", reason: "unreadable" },
    }]]));
  });

  it("publishes and lists valid ACP choices unchanged alongside an invalid item", async () => {
    const test = setup();
    const envelope = { requestId: "valid", threadId: "owner", body };
    test.provider.pending = [envelope, { requestId: "bad", threadId: "owner", body: null }];
    test.provider.resolveApproval.mockResolvedValue({ status: "resolved" });
    test.provider.emit("approval_request", envelope);
    const expected = { requestId: "valid", threadId: "owner", providerId: "cursor", ...body };
    expect(test.publishApprovalRequest.mock.calls).toEqual([[expected]]);
    expect(test.service.listPendingApprovals("owner")).toEqual([expected]);
    expect(test.service.listPendingApprovals("other")).toEqual([]);
    await vi.waitFor(() => expect(test.provider.resolveApproval.mock.calls).toEqual([["bad", { autoDeny: "unreadable" }]]));
  });

  it("never exposes a shortened oversized command", async () => {
    const test = setup();
    test.provider.resolveApproval.mockResolvedValue({ status: "resolved" });
    test.provider.emit("approval_request", { requestId: "large", threadId: "owner", body: { ...body, subject: { kind: "command", command: "x".repeat(70_000) } } });
    await vi.waitFor(() => expect(test.provider.resolveApproval.mock.calls).toEqual([["large", { autoDeny: "too_large" }]]));
    expect(test.publishApprovalRequest.mock.calls.map(([request]) => request.subject)).toEqual([{ kind: "tool", toolName: UNREADABLE_APPROVAL_TITLE }]);
  });

  it("returns not_pending for an unknown id and coalesces competing answers", async () => {
    const test = setup();
    expect(await test.service.respondToApproval("absent", { choiceId: "allow" })).toEqual({ status: "not_pending" });
    test.provider.pending = [{ requestId: "valid", threadId: "owner", body }];
    test.provider.resolveApproval.mockResolvedValue({ status: "failed", message: "offline" });
    const results = await Promise.all([
      test.service.respondToApproval("valid", { choiceId: "reject_always" }),
      test.service.respondToApproval("valid", { choiceId: "allow" }),
    ]);
    expect(results).toEqual([{ status: "failed", message: "offline" }, { status: "failed", message: "offline" }]);
    expect(test.provider.resolveApproval.mock.calls).toEqual([["valid", { choiceId: "reject_always" }]]);
  });
});
