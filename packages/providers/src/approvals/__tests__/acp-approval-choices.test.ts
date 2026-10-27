import { describe, expect, it } from "vitest";
import { ApprovalRequestBodySchema } from "@mcode/contracts/models/approval";
import { acpApprovalChoices } from "../../approval-scope.js";

type AcpOption = Parameters<typeof acpApprovalChoices>[0][number];

function body(options: AcpOption[]) {
  const choices = acpApprovalChoices(options);
  return {
    requestedAt: "2026-10-13T12:00:00.000Z", subject: { kind: "command" as const, command: "git status" },
    choices, origin: { kind: "agent" as const },
  };
}

describe("acpApprovalChoices", () => {
  it("drops an allow option whose scope is too long to state, keeping the rest of the request valid", () => {
    const request = body([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always", description: "x".repeat(501) },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);

    expect(ApprovalRequestBodySchema().safeParse(request).success).toBe(true);
    expect(request.choices.map((choice) => choice.id)).toEqual(["once", "reject"]);
  });

  it("keeps a native reject whose label or description is too long under a plain label", () => {
    const request = body([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "r".repeat(201), kind: "reject_once", description: "x".repeat(501) },
    ]);

    expect(ApprovalRequestBodySchema().safeParse(request).success).toBe(true);
    expect(request.choices.find((choice) => choice.intent === "deny")).toEqual({ id: "reject", intent: "deny", label: "Deny" });
  });

  it("falls back to the synthetic deny when the native reject id cannot be shown", () => {
    const request = body([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "r".repeat(201), name: "Reject", kind: "reject_once" },
    ]);

    expect(ApprovalRequestBodySchema().safeParse(request).success).toBe(true);
    expect(request.choices.filter((choice) => choice.intent === "deny").map((choice) => choice.id)).toEqual(["mcode-deny"]);
  });
});
