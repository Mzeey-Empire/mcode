import { describe, expect, it, vi } from "vitest";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { ApprovalRequestBodySchema } from "@mcode/contracts";
import { CursorAcpClientBridge } from "../cursor-acp-client-bridge.js";
import { mapResponseToAcpOutcome, pickFullAccessAllowOption } from "../cursor-acp-permission-mapper.js";

const options: PermissionOption[] = [
  { kind: "allow_once", name: "Run once", optionId: "once" },
  { kind: "allow_always", name: "Always run", optionId: "always" },
  { kind: "reject_once", name: "Reject once", optionId: "reject_once" },
  { kind: "reject_always", name: "Reject always", optionId: "reject_always" },
];

function setup() {
  const emitApprovalRequest = vi.fn();
  const emitApprovalResolved = vi.fn();
  const bridge = new CursorAcpClientBridge({
    settings: { get: () => { throw new Error("Settings are unused by permission resolution"); } },
    publishEvent: vi.fn(), publishNativeTurnDiff: vi.fn(), emitPlanCaptured: vi.fn(),
    emitApprovalRequest, emitApprovalResolved,
  });
  return { bridge, emitApprovalRequest, emitApprovalResolved };
}

const entry = { permissionMode: "default" as const, threadId: "owner", mcodeSessionId: "mcode-owner" };
const toolCall = { toolCallId: "tool-1", title: "Bash", kind: "execute" as const, rawInput: { command: "echo ok" } };

describe("Cursor native approval boundary", () => {
  it("keeps both reject choices and sends reject_always by its exact id", async () => {
    const test = setup();
    const native = test.bridge.requestPermission(entry, { sessionId: "session-1", toolCall, options });
    await Promise.resolve();
    const [request] = test.bridge.listPendingApprovals("owner");
    if (!request) throw new Error("Expected a pending request");
    const body = ApprovalRequestBodySchema().parse(request.body);
    expect(body.toolCallId).toBe("tool-1");
    expect(body.subject).toEqual({ kind: "command", command: "echo ok" });
    expect(body.choices).toEqual([
      { id: "once", intent: "allow_once", label: "Run once" },
      { id: "always", intent: "provider", label: "Always run" },
      { id: "reject_once", intent: "deny", label: "Reject once" },
      { id: "reject_always", intent: "deny", label: "Reject always" },
    ]);
    expect(body.noteChoiceId).toBe("reject_once");
    expect(test.emitApprovalRequest.mock.calls).toEqual([[request]]);
    expect(await test.bridge.resolveApproval(request.requestId, { choiceId: "reject_always" })).toEqual({ status: "resolved" });
    await expect(native).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_always" } });
    expect(test.emitApprovalResolved.mock.calls).toEqual([[{
      requestId: request.requestId, threadId: "owner", outcome: { status: "denied", choiceLabel: "Reject always" },
    }]]);
    expect(test.bridge.listPendingApprovals()).toEqual([]);
  });

  it("answers a synthetic deny with native cancellation when only allow options exist", async () => {
    const test = setup();
    const native = test.bridge.requestPermission(entry, { sessionId: "session-1", toolCall, options: options.slice(0, 2) });
    await Promise.resolve();
    const [request] = test.bridge.listPendingApprovals();
    if (!request) throw new Error("Expected a pending request");
    expect(await test.bridge.resolveApproval(request.requestId, { choiceId: "mcode-deny" })).toEqual({ status: "resolved" });
    await expect(native).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(test.emitApprovalResolved.mock.calls).toEqual([[{
      requestId: request.requestId, threadId: "owner", outcome: { status: "cancelled", reason: "unanswerable" },
    }]]);
  });

  it("auto-denies a 70000-character command without publishing a shortened request", async () => {
    const test = setup();
    const native = test.bridge.requestPermission(entry, { sessionId: "session-1", toolCall: { ...toolCall, rawInput: { command: "x".repeat(70_000) } }, options });
    await expect(native).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    await vi.waitFor(() => expect(test.emitApprovalResolved.mock.calls.map(([event]) => event.outcome)).toEqual([{ status: "auto_denied", reason: "too_large" }]));
    expect(test.emitApprovalRequest.mock.calls).toEqual([]);
  });

  it("never substitutes allow_always for allow_once", () => {
    expect(mapResponseToAcpOutcome({ choiceId: "once" }, [options[1]!])).toEqual({ outcome: "cancelled" });
    expect(mapResponseToAcpOutcome({ choiceId: "once" }, options)).toEqual({ outcome: "selected", optionId: "once" });
    expect(mapResponseToAcpOutcome({ autoDeny: "unreadable" }, options)).toEqual({ outcome: "selected", optionId: "reject_once" });
    expect(mapResponseToAcpOutcome({ choiceId: "once" }, options.slice(2))).toEqual({ outcome: "cancelled" });
    expect(pickFullAccessAllowOption(options)).toBe("always");
    expect(pickFullAccessAllowOption(options.slice(2))).toBeUndefined();
  });
});
