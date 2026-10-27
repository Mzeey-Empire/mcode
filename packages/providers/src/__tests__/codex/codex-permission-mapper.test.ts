import { describe, it, expect, vi } from "vitest";
import { ApprovalRequestBodySchema } from "@mcode/contracts/models/approval";

vi.mock("@mcode/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mcode/shared")>(),
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  codexApprovalFileChange,
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

describe("codexApprovalFileChange", () => {
  function filesFrom(changes: unknown[]) {
    const subject = codexApprovalFileChange({ method: "item/fileChange/patchUpdated", params: { threadId: "t", itemId: "i", changes } })?.subject;
    return subject?.kind === "file_edit" ? subject.files : [];
  }

  it("adds file headers to the header-less hunks Codex sends for an update", () => {
    const [file] = filesFrom([{ path: String.raw`C:\repo\a.ts`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" }]);
    expect(file).toMatchObject({ change: "edited", additions: 1, deletions: 1, patch: "--- a/C:/repo/a.ts\n+++ b/C:/repo/a.ts\n@@ -1 +1 @@\n-old\n+new\n" });
  });

  it("drops the Moved to note and targets the new path for a move", () => {
    const [file] = filesFrom([{ path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "@@ -1 +1 @@\n-old\n+new\n\n\nMoved to: b.ts" }]);
    expect(file?.patch).toBe("--- a/a.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n");
  });

  it("turns the whole-file content Codex sends for an add or delete into a patch", () => {
    const [added, removed] = filesFrom([
      { path: "new.ts", kind: { type: "add" }, diff: "one\ntwo\n" },
      { path: "old.ts", kind: { type: "delete" }, diff: "gone\n" },
    ]);
    expect(added).toMatchObject({ change: "added", additions: 2, deletions: 0 });
    expect(added?.patch).toContain("+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two");
    expect(removed).toMatchObject({ change: "removed", additions: 0, deletions: 1 });
    expect(removed?.patch).toContain("--- a/old.ts\n+++ /dev/null");
  });
});

describe("synthesizeCodexApprovalRequest", () => {
  it("accepts a long network hostname without shortening it", () => {
    const request = synthesizeCodexApprovalRequest({ method: "item/commandExecution/requestApproval",
      params: { command: "curl", networkApprovalContext: { host: "artifacts.internal-registry.example-corp.com", protocol: "https" } } });
    expect(ApprovalRequestBodySchema().parse(request).reason).toBe('Network: {"host":"artifacts.internal-registry.example-corp.com","protocol":"https"}');
  });

  it("preserves an oversized reason for server validation", () => {
    const request = synthesizeCodexApprovalRequest({ method: "execCommandApproval", params: { command: "curl", reason: "x".repeat(1_001) } });
    expect(request.reason).toBe("x".repeat(1_001));
    expect(ApprovalRequestBodySchema().safeParse(request).success).toBe(false);
  });
  it("keeps command scope, tool identity and whole network context in the reason", () => {
    const request = synthesizeCodexApprovalRequest({ method: "item/commandExecution/requestApproval",
      params: { itemId: "tool-1", command: "curl example.com", cwd: "/tmp", reason: "fetch page", networkApprovalContext: { host: "example.com" } } });
    expect(request.subject).toEqual({ kind: "command", command: "curl example.com", cwd: "/tmp" });
    expect(request.toolCallId).toBe("tool-1");
    expect(request.reason).toBe('fetch page\nNetwork: {"host":"example.com"}');
    expect(request.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "allow-session", intent: "allow_scoped", label: "Allow for this session" },
      { id: "deny", intent: "deny", label: "Deny" },
    ]);
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
