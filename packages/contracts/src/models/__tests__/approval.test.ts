import { describe, expect, it } from "vitest";
import { ApprovalAnswersSchema, ApprovalRequestBodySchema, ApprovalRequestSchema } from "../approval.js";

import { WS_METHODS } from "../../ws/methods.js";

const body = {
  requestedAt: "2026-10-10T10:00:00Z",
  subject: { kind: "command", command: "bun run lint" },
  choices: [
    { id: "allow", intent: "allow_once", label: "Allow once" },
    { id: "reject_once", intent: "deny", label: "Reject once" },
    { id: "reject_always", intent: "deny", label: "Reject always" },
  ],
  noteDelivery: "next_turn", noteChoiceId: "reject_once", origin: { kind: "agent" },
};

describe("approval choice safety", () => {
  it("preserves distinct reject choices and exact labels", () => {
    expect(ApprovalRequestBodySchema().parse(body)).toEqual(body);
    expect(ApprovalRequestSchema().parse({ ...body, requestId: "request", threadId: "owner", providerId: "cursor" }))
      .toEqual({ ...body, requestId: "request", threadId: "owner", providerId: "cursor" });
  });
  it.each([
    { ...body, choices: [body.choices[0]] },
    { ...body, noteChoiceId: undefined },
    { ...body, noteChoiceId: "allow" },
    { ...body, choices: [...body.choices, { id: "allow", intent: "deny", label: "Deny" }] },
    { ...body, subject: { kind: "command", command: "x".repeat(70_000) } },
  ])("rejects the same unsafe body at both boundaries", (invalid) => {
    expect(ApprovalRequestBodySchema().safeParse(invalid).success).toBe(false);
    expect(ApprovalRequestSchema().safeParse({ ...invalid, requestId: "request", threadId: "owner", providerId: "cursor" }).success).toBe(false);
  });
  it("requires provider identity for agent approvals", () => {
    expect(ApprovalRequestSchema().safeParse({ ...body, requestId: "request", threadId: "owner", providerId: null }).success).toBe(false);
    expect(ApprovalRequestSchema().parse({ ...body, requestId: "request", threadId: "owner", providerId: null, origin: { kind: "integration", label: "Integration" } }).providerId).toBe(null);
  });
  it("rejects routing keys embedded in an adapter body", () => {
    expect(ApprovalRequestBodySchema().safeParse({ ...body, threadId: "spoof" }).success).toBe(false);
  });
});
describe("provider questions", () => {
  it("preserves bounded metadata and exact custom reply text", () => {
    const questions = [{ header: "Deploy", question: "Where should this go?", options: [{ label: "Production", description: "Ship now" }], multiple: false, custom: true }];
    const request = ApprovalRequestSchema().parse({
      ...body, requestId: "que_1", threadId: "thread-1", providerId: "opencode",
      subject: { kind: "question", questions }, noteDelivery: "none", noteChoiceId: undefined,
    });
    expect(request.subject).toEqual({ kind: "question", questions });
    expect(WS_METHODS()["approval.respond"].params.parse({
      requestId: "que_1", choiceId: "answer", answers: [[" staging "]],
    }).answers).toEqual([[" staging "]]);
  });
  it("rejects blank and oversized answers before provider ingress", () => {
    expect(ApprovalAnswersSchema().safeParse([["  "]]).success).toBe(false);
    expect(ApprovalAnswersSchema().safeParse([["x".repeat(101)]]).success).toBe(false);
    expect(WS_METHODS()["approval.respond"].params.safeParse({
      requestId: "que_1", choiceId: "answer", answers: Array.from({ length: 11 }, () => ["Yes"]),
    }).success).toBe(false);
  });
});
