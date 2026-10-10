import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { ApprovalRequestEnvelope, TurnRequest } from "@mcode/contracts";

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

interface FakeHttp {
  createSession: ReturnType<typeof vi.fn>;
  promptAsync: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
  listSessionMessages: ReturnType<typeof vi.fn>;
  replyPermission: ReturnType<typeof vi.fn>;
  replyQuestion: ReturnType<typeof vi.fn>;
  rejectQuestion: ReturnType<typeof vi.fn>;
  subscribeEvents: ReturnType<typeof vi.fn>;
  getSessionStatus: ReturnType<typeof vi.fn>;
}

function fakeHttp(envelopes: unknown[]): FakeHttp {
  let emit: ((e: unknown) => void) | null = null;
  const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
  const fake = {
    createSession: vi.fn(async () => ({ id: "ses_1" })),
    promptAsync: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessionMessages: vi.fn(async () => []),
    // A relayed decision unblocks the fake upstream: the next step ends idle,
    // which is what lets the turn settle.
    replyPermission: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    replyQuestion: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    rejectQuestion: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
    subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      emit = onEnvelope;
      for (const envelope of envelopes) onEnvelope(envelope);
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  };
  return fake;
}

function testProvider(http: FakeHttp) {
  const settingsService = { get: () => ({ provider: { cli: { opencode: "opencode" }, opencode: { serveUrl: "" } } }) };
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
    pool: testPool(),
    http: http as never,
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
    idleConfirm: { intervalMs: 5, requiredPolls: 2, timeoutMs: 500, maxPollErrors: 2 },
  });
  return provider;
}

function turnRequest(permissionMode: "full" | "supervised" = "supervised"): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "55555555-5555-4555-8555-555555555555",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "run the thing",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode,
    approvalReviewMode: "manual",
    interactionMode: "build",
    providerOptions: {},
  } as TurnRequest<"opencode">;
}

function shellAsk(id = "per_1") {
  return {
    type: "permission.v2.asked",
    properties: { id, sessionID: "ses_1", action: "bash", resources: ["echo hi"] },
  };
}

function questionAsk(id = "que_1") {
  return {
    type: "question.v2.asked",
    properties: {
      id,
      sessionID: "ses_1",
      questions: [
        { header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    },
  };
}

describe("OpenCodeProvider approval-review support", () => {
  it("honestly reports unavailable for every input without touching upstream", async () => {
    const http = fakeHttp([]);
    const provider = testProvider(http);

    const expected = {
      status: "unavailable",
      supportedModes: ["manual"],
      reason: "opencode-lacks-native-approval-review",
      liveChangeScope: "none",
    };
    await expect(provider.getApprovalReviewSupport({
      permissionMode: "supervised",
      interactionMode: "build",
      requestedMode: "automatic",
      model: "anthropic/claude-sonnet-4-6",
    })).resolves.toEqual(expected);
    await expect(provider.getApprovalReviewSupport({
      permissionMode: "full",
      interactionMode: "build",
      requestedMode: "automatic",
      model: "anthropic/claude-sonnet-4-6",
    })).resolves.toEqual(expected);
    await expect(provider.getApprovalReviewSupport({
      permissionMode: "supervised",
      interactionMode: "plan",
      requestedMode: "manual",
      model: "anthropic/claude-sonnet-4-6",
    })).resolves.toEqual(expected);

    expect(http.subscribeEvents).not.toHaveBeenCalled();
    expect(http.createSession).not.toHaveBeenCalled();
    expect(http.promptAsync).not.toHaveBeenCalled();
    expect(http.listModels).not.toHaveBeenCalled();
    await provider.shutdown();
  });
});

describe("OpenCodeProvider full-access permission bypass", () => {
  it("auto-replies always to a permission ask in full mode without carding", async () => {
    const http = fakeHttp([shellAsk()]);
    const provider = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    const resolved: unknown[] = [];
    provider.on("approval_request", (request) => cards.push(request));
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    await provider.sendTurn(turnRequest("full"));

    expect(cards).toHaveLength(0);
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    expect(http.replyPermission).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", "per_1", "always", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "allowed", intent: "allow_scoped", choiceLabel: "Full access" } }]);
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(0);
    await provider.shutdown();
  });

  it("still cards a question ask in full mode", async () => {
    const http = fakeHttp([questionAsk()]);
    const provider = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    const sending = provider.sendTurn(turnRequest("full"));
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]?.body).toMatchObject({ subject: { kind: "question" } });
    expect(http.replyPermission).not.toHaveBeenCalled();
    expect(http.rejectQuestion).not.toHaveBeenCalled();

    expect(await provider.resolveApproval("que_1", { choiceId: "reject" })).toEqual({ status: "resolved" });
    await sending;
    expect(http.rejectQuestion).toHaveBeenCalledTimes(1);
    await provider.shutdown();
  });

  it("cards a permission ask without auto-replying in supervised mode", async () => {
    const http = fakeHttp([shellAsk()]);
    const provider = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    const sending = provider.sendTurn(turnRequest("supervised"));
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(http.replyPermission).not.toHaveBeenCalled();

    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toEqual({ status: "resolved" });
    await sending;
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    expect(http.replyPermission).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", "per_1", "once", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await provider.shutdown();
  });

  it("replies once to a replayed permission ask in full mode", async () => {
    const http = fakeHttp([shellAsk(), shellAsk()]);
    const provider = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    await provider.sendTurn(turnRequest("full"));

    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "allowed", intent: "allow_scoped", choiceLabel: "Full access" } }]);
    await provider.shutdown();
  });
});
