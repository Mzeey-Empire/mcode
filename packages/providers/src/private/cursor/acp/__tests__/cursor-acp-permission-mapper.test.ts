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
  const publishEvent = vi.fn();
  const bridge = new CursorAcpClientBridge({
    settings: { get: () => { throw new Error("Settings are unused by permission resolution"); } },
    publishEvent, publishNativeTurnDiff: vi.fn(), emitPlanCaptured: vi.fn(),
    emitApprovalRequest, emitApprovalResolved,
  });
  const requestPermission = (
    entry: Parameters<CursorAcpClientBridge["requestPermission"]>[0],
    request: Parameters<CursorAcpClientBridge["requestPermission"]>[1],
  ) => bridge.requestPermission(entry, request, (event) => publishEvent(entry, event));
  return { bridge, requestPermission, emitApprovalRequest, emitApprovalResolved, publishEvent };
}

const entry = { permissionMode: "default" as const, threadId: "owner", mcodeSessionId: "mcode-owner",
  connection: { signal: new AbortController().signal }, child: { exitCode: null } };
const toolCall = { toolCallId: "tool-1", title: "Bash", kind: "execute" as const, rawInput: { command: "echo ok" } };

describe("Cursor native approval boundary", () => {
  it("denies natively and leaves the note for the next turn", async () => {
    const test = setup();
    const native = test.requestPermission(entry, { sessionId: "session-1", toolCall, options });
    const [request] = test.bridge.listPendingApprovals("owner");
    if (!request) throw new Error("Expected a pending request");
    expect(await test.bridge.resolveApproval(request.requestId, { choiceId: "reject_once", note: "Only lint the web app" }))
      .toEqual({ status: "resolved", noteDelivery: "next_turn" });
    expect(await native).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(test.publishEvent.mock.calls.map(([, event]) => event)).toMatchObject([
      { type: "approvalDecided", outcome: { status: "denied", note: "Only lint the web app", noteDelivery: "next_turn" } },
    ]);
  });

  it("keeps both reject choices and sends reject_always by its exact id", async () => {
    const test = setup();
    const native = test.requestPermission(entry, { sessionId: "session-1", toolCall, options });
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
    expect(test.publishEvent.mock.calls.map(([, event]) => event)).toEqual([{
      type: "approvalDecided", threadId: "owner", requestId: request.requestId, toolCallId: "tool-1",
      kind: "command", subjectLabel: "echo ok", origin: { kind: "agent" }, outcome: { status: "denied", choiceLabel: "Reject always" },
    }]);
  });

  it.each([false, true])("drains one receipt and preserves a failed auto-deny's cause: %s", async (failedDeny) => {
    const test = setup();
    const controller = new AbortController();
    const session = { ...entry, connection: { signal: controller.signal } };
    const native = test.requestPermission(session, { sessionId: "session-1", toolCall, options });
    const [request] = test.bridge.listPendingApprovals();
    if (!request) throw new Error("Missing approval");
    if (failedDeny) {
      controller.abort();
      expect(await test.bridge.resolveApproval(request.requestId, { autoDeny: "unreadable" })).toMatchObject({ status: "failed" });
    }
    test.bridge.cancelPendingForSession("mcode-owner");
    test.bridge.cancelAllPending();
    await expect(native).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(test.publishEvent.mock.calls.map(([, event]) => event.outcome)).toEqual([
      { status: "cancelled", reason: failedDeny ? "unanswerable" : "session_stopped" },
    ]);
  });

  it("answers a synthetic deny with native cancellation when only allow options exist", async () => {
    const test = setup();
    const native = test.requestPermission(entry, { sessionId: "session-1", toolCall, options: options.slice(0, 2) });
    await Promise.resolve();
    const [request] = test.bridge.listPendingApprovals();
    if (!request) throw new Error("Expected a pending request");
    expect(await test.bridge.resolveApproval(request.requestId, { choiceId: "mcode-deny" })).toEqual({ status: "resolved" });
    await expect(native).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(test.emitApprovalResolved.mock.calls).toEqual([[{
      requestId: request.requestId, threadId: "owner", outcome: { status: "denied", choiceLabel: "Deny" },
    }]]);
  });

  it("emits the whole oversized command for server validation", async () => {
    const test = setup();
    const native = test.requestPermission(entry, { sessionId: "session-1", toolCall: { ...toolCall, rawInput: { command: "x".repeat(70_000) } }, options });
    await Promise.resolve();
    const [request] = test.bridge.listPendingApprovals();
    expect(test.emitApprovalRequest.mock.calls).toEqual([[request]]);
    expect(request?.body).toMatchObject({ subject: { kind: "command", command: "x".repeat(70_000) } });
    expect(test.emitApprovalResolved.mock.calls).toEqual([]);
    test.bridge.cancelAllPending();
    await expect(native).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it.each(["connection", "session"])("fails without answering when the %s is closed", async (closed) => {
    const test = setup();
    const controller = new AbortController();
    const child: { exitCode: number | null } = { exitCode: null };
    const session = { ...entry, connection: { signal: controller.signal }, child };
    const native = test.requestPermission(session, { sessionId: "session-1", toolCall, options });
    const answered = vi.fn();
    void native.then(answered);
    await Promise.resolve();
    const [request] = test.bridge.listPendingApprovals();
    if (!request) throw new Error("Expected a pending request");
    if (closed === "connection") controller.abort();
    else session.child.exitCode = 0;
    expect(await test.bridge.resolveApproval(request.requestId, { choiceId: "once" })).toMatchObject({ status: "failed" });
    expect(answered.mock.calls).toEqual([]);
    expect(test.emitApprovalResolved.mock.calls).toEqual([]);
    expect(test.bridge.listPendingApprovals()).toEqual([request]);
    test.bridge.cancelAllPending();
    await native;
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
