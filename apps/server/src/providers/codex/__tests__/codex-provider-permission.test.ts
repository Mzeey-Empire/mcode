import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexProvider } from "../codex-provider.js";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";

/**
 * These tests exercise the provider-level permission plumbing in isolation:
 * handleApprovalRequest, resolvePermission, listPendingPermissions,
 * stopSession drain, shutdown drain. They do NOT spawn a codex child
 * process; we call handleApprovalRequest directly as if CodexAppServer
 * had invoked our handler.
 */
describe("CodexProvider permission flow", () => {
  let provider: CodexProvider;
  const threadId = "thread-abc";
  const sessionId = "mcode-" + threadId;

  beforeEach(() => {
    vi.useFakeTimers();
    // settingsService is unused for these paths; pass a minimal stub.
    provider = new CodexProvider({ get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never);
    // Pre-register a session entry so drain logic has something to iterate.
    (provider as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, {
      server: { kill: vi.fn().mockResolvedValue(undefined), isAlive: true },
      mapper: { reset: vi.fn() },
      lastUsedAt: Date.now() - 1000,
      sandboxMode: "workspace-write",
    });
  });

  it("emits permission_request and lists the pending entry when handler is invoked", async () => {
    const emitted: PermissionRequest[] = [];
    provider.on("permission_request", (r) => emitted.push(r));

    const resultPromise = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls -la", cwd: "/tmp" },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].toolName).toBe("Shell");
    expect(emitted[0].threadId).toBe(threadId);
    expect(emitted[0].input).toEqual({ command: "ls -la", cwd: "/tmp" });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(emitted[0].requestId);

    // Resolve and assert the handler's promise produces the mapped response.
    const resolved = provider.resolvePermission!(emitted[0].requestId, "allow");
    expect(resolved).toBe(true);

    const response = await resultPromise;
    expect(response).toEqual({ decision: "accept" });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });

  it("emits permission_resolved when resolvePermission fires", async () => {
    const resolved: Array<{ requestId: string; decision: PermissionDecision }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p));

    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 7,
      method: "item/fileChange/requestApproval",
      params: { itemId: "x" },
    });

    const pending = provider.listPendingPermissions!(threadId);
    provider.resolvePermission!(pending[0].requestId, "deny");

    await p;
    expect(resolved).toEqual([{ requestId: pending[0].requestId, decision: "deny" }]);
  });

  it("returns false from resolvePermission when requestId is unknown", () => {
    expect(provider.resolvePermission!("does-not-exist", "allow")).toBe(false);
  });

  it("stopSession drains pending permissions as cancelled and emits events", async () => {
    const resolved: Array<{ requestId: string; decision: PermissionDecision }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p));

    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 11,
      method: "item/commandExecution/requestApproval",
      params: { command: "sleep 999", cwd: "/" },
    });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);
    const requestId = pending[0].requestId;

    provider.stopSession(sessionId);

    const response = await p;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toEqual([{ requestId, decision: "cancelled" }]);
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });

  it("shutdown drains pending permissions across all sessions", async () => {
    const p = (provider as unknown as {
      handleApprovalRequest: (sessionId: string, threadId: string, req: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 13,
      method: "applyPatchApproval",
      params: {},
    });

    const pending = provider.listPendingPermissions!(threadId);
    expect(pending).toHaveLength(1);

    provider.shutdown();

    const response = await p;
    expect(response).toEqual({ decision: "abort" });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });
});
