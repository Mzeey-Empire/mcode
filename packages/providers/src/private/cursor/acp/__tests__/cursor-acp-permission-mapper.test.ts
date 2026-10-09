import { describe, expect, it, vi } from "vitest";
import { CursorAcpClientBridge } from "../cursor-acp-client-bridge.js";
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
} from "../cursor-acp-permission-mapper.js";

describe("cursor-acp-permission-mapper", () => {
  const options = [
    { kind: "reject_once" as const, name: "No", optionId: "r1" },
    { kind: "allow_once" as const, name: "Yes", optionId: "a1" },
  ];

  it("pickFullAccessAllowOption prefers allow_always then allow_once", () => {
    expect(
      pickFullAccessAllowOption([
        { kind: "reject_once", name: "n", optionId: "r" },
        { kind: "allow_once", name: "y", optionId: "a" },
      ]),
    ).toBe("a");
    expect(
      pickFullAccessAllowOption([
        { kind: "allow_always", name: "all", optionId: "aa" },
        { kind: "allow_once", name: "y", optionId: "a" },
      ]),
    ).toBe("aa");
  });

  it("mapDecisionToAcpOutcome selects allow_once for allow", () => {
    expect(mapDecisionToAcpOutcome("allow", options)).toEqual({
      outcome: "selected",
      optionId: "a1",
    });
  });

  it("mapDecisionToAcpOutcome yields cancelled", () => {
    expect(mapDecisionToAcpOutcome("cancelled", options)).toEqual({ outcome: "cancelled" });
  });

  it("cancels deny when only allow options exist", () => {
    expect(mapDecisionToAcpOutcome("deny", [
      { kind: "allow_once", name: "Yes", optionId: "a1" },
      { kind: "allow_always", name: "Always", optionId: "aa" },
    ])).toEqual({ outcome: "cancelled" });
  });

  it("prefers reject_once over reject_always for deny", () => {
    expect(mapDecisionToAcpOutcome("deny", [
      { kind: "reject_always", name: "Never", optionId: "ra" },
      { kind: "reject_once", name: "No", optionId: "r1" },
    ])).toEqual({ outcome: "selected", optionId: "r1" });
  });

  it.each(["allow", "allow-session"] as const)("cancels %s when only reject options exist", (decision) => {
    expect(mapDecisionToAcpOutcome(decision, [
      { kind: "reject_once", name: "No", optionId: "r1" },
      { kind: "reject_always", name: "Never", optionId: "ra" },
    ])).toEqual({ outcome: "cancelled" });
  });

  it("reports cancelled through the bridge when deny has only allow options", async () => {
    const emitPermissionRequest = vi.fn();
    const emitPermissionResolved = vi.fn();
    const bridge = new CursorAcpClientBridge({
      settings: { get: () => { throw new Error("Settings are unused by permission resolution"); } },
      publishEvent: vi.fn(), publishNativeTurnDiff: vi.fn(),
      emitPermissionRequest, emitPermissionResolved, emitPlanCaptured: vi.fn(),
    });
    const response = bridge.requestPermission({
      permissionMode: "default", threadId: "thread-1", mcodeSessionId: "mcode-thread-1",
    }, {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Bash", rawInput: { command: "echo ok" } },
      options: [{ kind: "allow_once", name: "Yes", optionId: "a1" }],
    });
    await Promise.resolve();
    const [request] = bridge.listPendingPermissions("thread-1");
    if (!request) throw new Error("Expected a pending permission");

    expect(emitPermissionRequest.mock.calls).toEqual([[{
      requestId: request.requestId, threadId: "thread-1", toolName: "Bash", title: "Bash", input: { command: "echo ok" },
    }]]);
    expect(bridge.resolvePermission(request.requestId, "deny")).toBe(true);
    await expect(response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(emitPermissionResolved.mock.calls).toEqual([[request.requestId, "cancelled"]]);
    expect(bridge.listPendingPermissions("thread-1")).toEqual([]);
  });
});
