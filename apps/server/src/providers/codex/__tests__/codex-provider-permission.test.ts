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
    // settingsService and jobObject are unused for these paths; pass minimal stubs.
    provider = new CodexProvider(
      { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { assign: vi.fn() } as never,
    );
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

  it("drains pending permissions when the fatal handler fires on the app-server", async () => {
    const resolved: Array<{ requestId: string; decision: string }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p as never));

    // Re-register session with a fake server that we can drive fatal from.
    const sessions = (provider as unknown as {
      sessions: Map<string, { server: unknown; lastUsedAt: number; sandboxMode: string; mapper: unknown }>;
    }).sessions;
    const fakeServer = new (require("events").EventEmitter)();
    fakeServer.kill = vi.fn().mockResolvedValue(undefined);
    fakeServer.isAlive = true;
    sessions.set(sessionId, {
      server: fakeServer,
      mapper: { reset: vi.fn() },
      lastUsedAt: Date.now(),
      sandboxMode: "workspace-write",
    });

    // Install the fatal listener that sendMessage is responsible for wiring.
    (provider as unknown as {
      attachFatalDrain: (sessionId: string, server: unknown) => void;
    }).attachFatalDrain(sessionId, fakeServer);

    const p = (provider as unknown as {
      handleApprovalRequest: (s: string, t: string, r: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 202,
      method: "item/commandExecution/requestApproval",
      params: { command: "x", cwd: "/" },
    });

    fakeServer.emit("fatal", "simulated fatal");

    const response = await p;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("cancelled");
  });

  it("evictIdleSessions skips sessions that have pending permissions", () => {
    // Force the session's lastUsedAt well past the idle threshold.
    const sessions = (provider as unknown as {
      sessions: Map<string, { lastUsedAt: number; server: { kill: () => Promise<void> } }>;
    }).sessions;
    const existing = sessions.get(sessionId)!;
    existing.lastUsedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago

    // Queue a pending permission on the same thread.
    void (provider as unknown as {
      handleApprovalRequest: (s: string, t: string, r: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 99,
      method: "item/commandExecution/requestApproval",
      params: { command: "x", cwd: "/" },
    });

    (provider as unknown as { evictIdleSessions: () => void }).evictIdleSessions();

    // Session must NOT have been evicted while a permission is pending.
    expect(sessions.has(sessionId)).toBe(true);
  });

  it("drains pending permissions when sendMessage detects a permission mode swap", async () => {
    const resolved: Array<{ requestId: string; decision: string }> = [];
    provider.on("permission_resolved", (p) => resolved.push(p as never));

    // Queue a pending permission on the existing workspace-write session.
    const pendingPromise = (provider as unknown as {
      handleApprovalRequest: (s: string, t: string, r: unknown) => Promise<unknown>;
    }).handleApprovalRequest(sessionId, threadId, {
      rpcId: 55,
      method: "item/commandExecution/requestApproval",
      params: { command: "x", cwd: "/" },
    });
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(1);

    // Point the settings stub at a bogus cliPath so checkCodexVersion fails
    // fast and sendMessage exits before spawning a real child process. The
    // mode-swap drain executes before the version check, which is what we
    // want to observe.
    (provider as unknown as {
      settingsService: { get: () => Promise<unknown> };
    }).settingsService = {
      get: async () => ({ provider: { cli: { codex: "/totally/bogus/codex-path" } } }),
    };

    vi.useRealTimers();
    await provider.sendMessage({
      sessionId,
      message: "hi",
      cwd: "/",
      model: "gpt-5",
      resume: false,
      permissionMode: "full",
    });

    const response = await pendingPromise;
    expect(response).toEqual({ decision: "cancel" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe("cancelled");
    expect(provider.listPendingPermissions!(threadId)).toHaveLength(0);
  });
});
