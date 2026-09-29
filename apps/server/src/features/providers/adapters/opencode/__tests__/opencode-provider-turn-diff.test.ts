import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { ProviderTurnDiffUpdate, TurnRequest } from "@mcode/contracts";

function testProvider(http: never, pool: OpenCodeServerPool) {
  const settingsService = { get: () => ({ provider: { cli: { opencode: "opencode" } } }) };
  const envService = { getEnv: () => ({}) };
  const host = {
    events: { submit: async () => ({ commit: {}, delivery: { ingress: "queued" } }) },
    processes: { attach: () => {}, terminateTree: async () => {} },
    runtime: { platform: "win32" },
    environment: { snapshot: () => ({}) },
    browser: {},
    threadControl: {},
    grants: {},
  };
  const provider = new OpenCodeProvider(settingsService as never, envService as never, host as never);
  provider.configureTestSeams({
    pool,
    http: http as never,
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
    idleConfirm: { intervalMs: 5, requiredPolls: 2, timeoutMs: 500, maxPollErrors: 2 },
  });
  return provider;
}

function testPool(): OpenCodeServerPool {
  return new OpenCodeServerPool({
    spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
    waitForHealth: async () => {},
    terminateTree: async () => {},
    findFreePort: async () => 4096,
    now: () => Date.now(),
    env: () => ({}),
  });
}

function turnRequest(): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "11111111-1111-4111-8111-111111111111",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "hello",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "full",
    interactionMode: "build",
    providerOptions: {},
  } as TurnRequest<"opencode">;
}

/** Full-context upstream patch for one changed line. */
function diffEvent(file: string, before: string, after: string) {
  return {
    type: "session.diff",
    properties: {
      sessionID: "ses_1",
      diff: [{
        file,
        patch: [
          `Index: ${file}`,
          "===================================================================",
          `--- ${file}`,
          `+++ ${file}`,
          "@@ -1,1 +1,1 @@",
          `-${before}`,
          `+${after}`,
          "",
        ].join("\n"),
        additions: 1,
        deletions: 1,
        status: "modified",
      }],
    },
  };
}

function fakeHttp(envelopes: unknown[]) {
  return {
    createSession: vi.fn(async () => ({ id: "ses_1" })),
    promptAsync: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessionMessages: vi.fn(async () => []),
    getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
    subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      for (const envelope of envelopes) onEnvelope(envelope);
      onEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } });
    }),
  };
}

describe("OpenCodeProvider native turn diff", () => {
  it("pushes a complete native snapshot keyed by the dispatched turn identity", async () => {
    const provider = testProvider(fakeHttp([diffEvent("notes.txt", "agent marker: old", "agent marker: new")]) as never, testPool());
    const updates: ProviderTurnDiffUpdate[] = [];
    provider.onTurnDiff((event) => updates.push(event));
    await provider.sendTurn(turnRequest());
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      turnId: "turn-1",
      turnExecutionId: "11111111-1111-4111-8111-111111111111",
      deliveryAttempt: 1,
      revision: 1,
      state: "snapshot",
      nativeFidelity: "agent",
    });
    const patch = (updates[0] as { patch: string }).patch;
    expect(patch).toContain("diff --git a/notes.txt b/notes.txt");
    expect(patch).toContain("-agent marker: old");
    expect(patch).toContain("+agent marker: new");
    provider.shutdown();
  });

  it("ignores a diff event owned by another upstream session", async () => {
    const foreign = diffEvent("notes.txt", "a", "b");
    foreign.properties.sessionID = "ses_other";
    const provider = testProvider(fakeHttp([foreign]) as never, testPool());
    const updates: ProviderTurnDiffUpdate[] = [];
    provider.onTurnDiff((event) => updates.push(event));
    await provider.sendTurn(turnRequest());
    expect(updates).toHaveLength(0);
    provider.shutdown();
  });

  it("pushes rejected evidence whole when one entry is unusable", async () => {
    const bad = { type: "session.diff", properties: { sessionID: "ses_1", diff: [{ file: "blob.bin", additions: 0, deletions: 0 }] } };
    const provider = testProvider(fakeHttp([diffEvent("notes.txt", "a", "b"), bad]) as never, testPool());
    const updates: ProviderTurnDiffUpdate[] = [];
    provider.onTurnDiff((event) => updates.push(event));
    await provider.sendTurn(turnRequest());
    expect(updates.map((update) => update.state)).toEqual(["snapshot", "rejected"]);
    provider.shutdown();
  });

  it("declares the turn-diff capability", () => {
    const provider = testProvider(fakeHttp([]) as never, testPool());
    expect(provider.descriptor.capabilities).toContainEqual({ name: "turn-diff", support: "supported" });
    provider.shutdown();
  });
});
