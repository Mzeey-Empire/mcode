import { describe, it, expect, vi } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  mapDecisionToCodexResponse,
  synthesizeCodexApprovalRequest,
  CODEX_APPROVAL_METHODS,
} from "../../private/codex/codex-permission-mapper.js";

describe("mapDecisionToCodexResponse", () => {
  describe("commandExecution / fileChange (v2)", () => {
    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps allow to { decision: 'accept' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "allow", {})).toEqual({ decision: "accept" });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps allow-session to { decision: 'acceptForSession' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "allow-session", {})).toEqual({
        decision: "acceptForSession",
      });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps deny to { decision: 'decline' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "deny", {})).toEqual({ decision: "decline" });
    });

    it.each([
      ["item/commandExecution/requestApproval"],
      ["item/fileChange/requestApproval"],
    ])("maps cancelled to { decision: 'cancel' } for %s", (method) => {
      expect(mapDecisionToCodexResponse(method, "cancelled", {})).toEqual({ decision: "cancel" });
    });
  });

  describe("item/permissions/requestApproval (v2)", () => {
    const method = "item/permissions/requestApproval";
    const echoed = { fileSystem: { read: ["/foo"], write: [] }, network: { enabled: false } };

    it("maps allow to echoed permissions with turn scope", () => {
      expect(mapDecisionToCodexResponse(method, "allow", { permissions: echoed })).toEqual({
        permissions: echoed,
        scope: "turn",
      });
    });

    it("maps allow-session to echoed permissions with session scope", () => {
      expect(mapDecisionToCodexResponse(method, "allow-session", { permissions: echoed })).toEqual({
        permissions: echoed,
        scope: "session",
      });
    });

    it("maps deny to empty permissions with turn scope", () => {
      expect(mapDecisionToCodexResponse(method, "deny", { permissions: echoed })).toEqual({
        permissions: {},
        scope: "turn",
      });
    });

    it("maps cancelled to empty permissions with turn scope (kill() handles interrupt)", () => {
      expect(mapDecisionToCodexResponse(method, "cancelled", { permissions: echoed })).toEqual({
        permissions: {},
        scope: "turn",
      });
    });
  });

  describe("legacy applyPatchApproval / execCommandApproval", () => {
    it.each([
      ["applyPatchApproval", "allow", "approved"],
      ["execCommandApproval", "allow", "approved"],
      ["applyPatchApproval", "allow-session", "approved_for_session"],
      ["execCommandApproval", "allow-session", "approved_for_session"],
      ["applyPatchApproval", "deny", "denied"],
      ["execCommandApproval", "deny", "denied"],
      ["applyPatchApproval", "cancelled", "abort"],
      ["execCommandApproval", "cancelled", "abort"],
    ] as const)("maps %s + %s to decision: %s", (method, decision, expected) => {
      expect(mapDecisionToCodexResponse(method, decision, {})).toEqual({ decision: expected });
    });
  });

  describe("unknown methods", () => {
    it("falls back to decline for unknown non-permissions methods", () => {
      expect(mapDecisionToCodexResponse("item/unknown/requestApproval", "deny", {})).toEqual({
        decision: "decline",
      });
    });

    it("falls back to empty permissions + turn for unknown permissions-like methods", () => {
      expect(
        mapDecisionToCodexResponse("item/somePermissionsThing/requestApproval", "deny", {}),
      ).toEqual({ permissions: {}, scope: "turn" });
    });
  });
});

describe("synthesizeCodexApprovalRequest", () => {
  it("keeps command scope, free tool identity and native network facts", () => {
    const request = synthesizeCodexApprovalRequest({ method: "item/commandExecution/requestApproval",
      params: { itemId: "tool-1", command: "curl example.com", cwd: "/tmp", reason: "fetch page", networkApprovalContext: { host: "example.com" } } });
    expect(request.subject).toEqual({ kind: "command", command: "curl example.com", cwd: "/tmp", facts: ['Network: {"host":"example.com"}'] });
    expect(request.toolCallId).toBe("tool-1");
    expect(request.reason).toBe("fetch page");
    expect(request.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "allow-session", intent: "allow_scoped", label: "Allow for this session" },
      { id: "deny", intent: "deny", label: "Deny" },
    ]);
    expect(request.noteDelivery).toBe("steer");
  });

  it.each([
    ["item/fileChange/requestApproval", { itemId: "abc123", grantRoot: "/repo" }, { kind: "tool", toolName: "FileWrite", preview: '{"itemId":"abc123","grantRoot":"/repo"}' }],
    ["item/permissions/requestApproval", { permissions: { network: true } }, { kind: "tool", toolName: "WorkspacePermissions", preview: '{"permissions":{"network":true}}' }],
    ["applyPatchApproval", { patch: "diff --git..." }, { kind: "tool", toolName: "ApplyPatch", preview: '{"patch":"diff --git..."}' }],
    ["execCommandApproval", { command: "echo hi" }, { kind: "command", command: "echo hi" }],
  ])("preserves the available scope for %s", (method, params, expected) => {
    expect(synthesizeCodexApprovalRequest({ method, params }).subject).toEqual(expected);
  });

  it("keeps an oversized command intact for fail-closed scope validation", () => {
    const request = synthesizeCodexApprovalRequest({ method: "item/commandExecution/requestApproval", params: { command: "x".repeat(70_000) } });
    expect(request.subject).toEqual({ kind: "command", command: "x".repeat(70_000) });
  });

  it("omits an absent native reason", () => {
    expect(synthesizeCodexApprovalRequest({ method: "execCommandApproval", params: { command: "echo hi" } }).reason).toBeUndefined();
  });
});

describe("CODEX_APPROVAL_METHODS", () => {
  it("exposes the five recognised method names", () => {
    expect(CODEX_APPROVAL_METHODS).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ]);
  });
});
