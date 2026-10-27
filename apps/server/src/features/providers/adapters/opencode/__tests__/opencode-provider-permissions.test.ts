import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import { z } from "zod";
import { ApprovalRequestBodySchema } from "@mcode/contracts/models/approval";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import { OpenCodeReplySessionNotFoundError } from "../opencode-http-client.js";
import { ApprovalService } from "../../../../agents/approvals/approval-service.js";
import { logger } from "@mcode/shared";
import type { ApprovalRequestEnvelope } from "@mcode/contracts/models/approval";
import type { TurnRequest } from "@mcode/contracts/providers/interfaces";

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
}

function fakeHttp(envelopes: unknown[], hooks?: { onPrompt?: () => void }): FakeHttp {
  let emit: ((e: unknown) => void) | null = null;
  const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
  const fake = {
    createSession: vi.fn(async () => ({ id: "ses_1" })),
    promptAsync: vi.fn(async () => {
      hooks?.onPrompt?.();
    }),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessionMessages: vi.fn(async () => []),
    // A relayed decision unblocks the fake upstream: the next step ends idle,
    // which is what lets the turn settle. Scheduled after the relay resolves
    // so the pending entry is already gone when confirmation checks.
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
      if (signal.aborted) return;
      // Production streams stay open until abort; returning early would trip
      // the stream-end fallback and mis-settle the turn in tests.
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
  const submitted: unknown[] = [];
  const host = {
    events: { submit: async (batch: unknown) => { submitted.push(batch); return { commit: {}, delivery: { ingress: "queued" } }; } },
    processes: { attach: () => {}, terminateTree: async () => {} },
    runtime: { platform: "win32" },
    environment: { snapshot: () => ({}) },
    browser: {},
    grants: {},
  };
  const provider = new OpenCodeProvider(settingsService as never, envService as never, host as never);
  provider.configureTestSeams({
    pool: testPool(),
    http: http as never,
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
    idleConfirm: { intervalMs: 5, requiredPolls: 2, timeoutMs: 500, maxPollErrors: 2 },
  });
  return { provider, submitted };
}

function turnRequest(): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "55555555-5555-4555-8555-555555555555",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "run the thing",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "supervised",
    interactionMode: "build",
    providerOptions: {},
  } as TurnRequest<"opencode">;
}

/** Unwrap canonical runtime events out of submitted ingress batches. */
function submittedEvents(submitted: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const batch of submitted) {
    const events = (batch as { events?: Array<{ payload?: unknown }> }).events ?? [];
    for (const draft of events) {
      const payload = draft?.payload as {
        item?: { payload?: { runtimeEvent?: { event?: Record<string, unknown> } } };
      } | undefined;
      const event = payload?.item?.payload?.runtimeEvent?.event;
      if (event) out.push(event);
    }
  }
  return out;
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
        { header: "Region", question: "Which region?", options: [{ label: "East" }] },
      ],
    },
  };
}

describe("OpenCodeProvider permission flow", () => {
  it.each([
    { save: undefined, description: "git *", choice: "once" },
    { save: [], description: "git *", choice: "once" },
    { save: ["git *", "node *"], description: "git *, node *", choice: "always" },
    { save: ["x".repeat(501)], description: "git *", choice: "once" },
  ])("states requested or saved scope without inventing a session grant: %j", async ({ save, description, choice }) => {
    const http = fakeHttp([{ type: "permission.v2.asked", properties: {
      id: "per_scope", sessionID: "ses_1", action: "bash", resources: ["git *"], ...(save === undefined ? {} : { save }),
    } }]);
    const { provider } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (card) => cards.push(card));
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const body = ApprovalRequestBodySchema().parse(cards[0]?.body);
    expect(body.choices).toEqual(choice === "always" ? [
      { id: "once", intent: "allow_once", label: "Allow once" },
      { id: "always", intent: "allow_scoped", label: "Always allow", description },
      { id: "reject", intent: "deny", label: "Deny" },
    ] : [
      { id: "once", intent: "allow_once", label: "Allow once", description },
      { id: "reject", intent: "deny", label: "Deny" },
    ]);
    if (choice === "once") {
      expect(await provider.resolveApproval("per_scope", { choiceId: "always" })).toMatchObject({ status: "failed" });
    }
    expect(await provider.resolveApproval("per_scope", { choiceId: choice })).toEqual({ status: "resolved" });
    await sending;
    expect(provider.listPendingApprovals("thread-1")).toEqual([]);
    expect(http.replyPermission.mock.calls.map((call) => call.slice(1, 5))).toEqual([["ses_1", "per_scope", choice, "v2"]]);
    await provider.shutdown();
  });

  it("cards a shell ask once and relays approve-once exactly once", async () => {
    const http = fakeHttp([shellAsk(), shellAsk()]);
    const { provider, submitted } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    expect(cards[0]?.requestId).toBe("per_1");
    expect(cards[0]?.threadId).toBe("thread-1");
    expect(ApprovalRequestBodySchema().parse(cards[0]?.body).subject).toEqual({ kind: "tool", toolName: "bash", preview: '{"action":"bash","resources":["echo hi"]}' });
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(1);

    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toEqual({ status: "resolved" });
    await sending;
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    expect(http.replyPermission).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", "per_1", "once", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(0);

    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toEqual({ status: "not_pending" });
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    const outcomes = submittedEvents(submitted)
      .filter((event) => event.type === "ended")
      .map((event) => event.outcome);
    expect(outcomes).toEqual(["completed"]);
    await provider.shutdown();
  });

  it("relays reject and resolves unknown ids as false", async () => {
    const http = fakeHttp([shellAsk()]);
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingApprovals("thread-1")).toHaveLength(1));
    expect(await provider.resolveApproval("per_1", { choiceId: "reject" })).toEqual({ status: "resolved" });
    await sending;
    expect(http.replyPermission).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", "per_1", "reject", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "denied", choiceLabel: "Deny" } }]);
    expect(await provider.resolveApproval("nope", { choiceId: "once" })).toEqual({ status: "not_pending" });
    await provider.shutdown();
  });

  it("relays exact question selections, rejects invalid answers locally, and rejects on deny", async () => {
    const http = fakeHttp([questionAsk("que_1"), questionAsk("que_2")]);
    const { provider, submitted } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    const bodies = cards.map((card) => ApprovalRequestBodySchema().parse(card.body));
    expect(bodies.map((body) => body.subject.kind)).toEqual(["question", "question"]);
    const subject = bodies[0]?.subject;
    if (subject?.kind !== "question") throw new Error("Expected question scope");
    expect(subject.questions).toEqual([
      {
        header: "Deploy",
        question: "Deploy now?",
        options: [{ label: "Yes" }, { label: "No" }],
        multiple: false,
        custom: false,
      },
      {
        header: "Region",
        question: "Which region?",
        options: [{ label: "East" }],
        multiple: false,
        custom: false,
      },
    ]);

    expect(await provider.resolveApproval("que_1", { choiceId: "answer" })).toMatchObject({ status: "failed" });
    expect(await provider.resolveApproval("que_1", { choiceId: "answer", answers: [["Yes", "No"], ["East"]] })).toMatchObject({ status: "failed" });
    expect(await provider.resolveApproval("que_1", { choiceId: "always", answers: [["Yes"], ["East"]] })).toMatchObject({ status: "failed" });
    expect(http.replyQuestion).not.toHaveBeenCalled();
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(2);

    expect(await provider.resolveApproval("que_1", { choiceId: "answer", answers: [["Yes"], ["East"]] })).toEqual({ status: "resolved" });
    await vi.waitFor(() => expect(http.replyQuestion).toHaveBeenCalledTimes(1));
    expect(http.replyQuestion).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" },
      "ses_1",
      "que_1",
      [["Yes"], ["East"]],
      "v2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await provider.resolveApproval("que_1", { choiceId: "answer", answers: [["Yes"], ["East"]] })).toEqual({ status: "not_pending" });

    expect(await provider.resolveApproval("que_2", { choiceId: "reject" })).toEqual({ status: "resolved" });
    expect(await provider.resolveApproval("que_2", { choiceId: "reject" })).toEqual({ status: "not_pending" });
    await sending;
    expect(http.rejectQuestion).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", "que_2", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(http.rejectQuestion).toHaveBeenCalledTimes(1);
    const receipts = submittedEvents(submitted).filter((event) => event.type === "approvalDecided");
    expect(receipts.map((event) => ({ requestId: event.requestId, outcome: event.outcome }))).toEqual([
      { requestId: "que_1", outcome: { status: "answered", count: 2 } },
      { requestId: "que_2", outcome: { status: "denied", choiceLabel: "Dismiss" } },
    ]);
    await provider.shutdown();
  });

  it("keeps a failed reply answerable instead of stalling the turn", async () => {
    const http = fakeHttp([shellAsk()]);
    http.replyPermission.mockRejectedValueOnce(new Error("connection reset"));
    const { provider } = testProvider(http);

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingApprovals("thread-1")).toHaveLength(1));
    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(http.replyPermission).toHaveBeenCalledTimes(1));
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(1);

    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toEqual({ status: "resolved" });
    await sending;
    expect(http.replyPermission).toHaveBeenCalledTimes(2);
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(0);
    await provider.shutdown();
  });

  it("drains pending cards as cancelled on stop", async () => {
    const http = fakeHttp([]);
    http.subscribeEvents.mockImplementationOnce(
      async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope(shellAsk());
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const { provider, submitted } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(1);
    await provider.stopSession("mcode-thread-1");
    await sending;
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } }]);
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(0);
    expect(submittedEvents(submitted).filter((event) => event.type === "approvalDecided").map((event) => event.outcome))
      .toEqual([{ status: "cancelled", reason: "session_stopped" }]);
    await provider.shutdown();
  });

  it("cancels an in-flight reply without a second local settlement", async () => {
    const http = fakeHttp([shellAsk()]);
    let replySignal: AbortSignal | undefined;
    http.replyPermission.mockImplementationOnce((
      _baseUrl: string,
      _sessionId: string,
      _permissionId: string,
      _response: string,
      _version: string,
      options?: { signal?: AbortSignal },
    ) => new Promise<void>((_resolve, reject) => {
      replySignal = options?.signal;
      replySignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingApprovals("thread-1")).toHaveLength(1));
    const replying = provider.resolveApproval("per_1", { choiceId: "once" });
    await vi.waitFor(() => expect(http.replyPermission).toHaveBeenCalledTimes(1));

    await provider.stopSession("mcode-thread-1");
    await sending;

    expect(replySignal?.aborted).toBe(true);
    expect(await replying).toMatchObject({ status: "failed" });
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } }]);
    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toEqual({ status: "not_pending" });
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    await provider.shutdown();
  });

  it("drains a replayed ask after stream termination so it can card again", async () => {
    const http = fakeHttp([shellAsk()]);
    http.subscribeEvents.mockImplementationOnce(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      onEnvelope(shellAsk());
    });
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));
    provider.on("approval_request", (request) => cards.push(request));

    await provider.sendTurn(turnRequest());

    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "turn_ended" } }]);
    expect(provider.listPendingApprovals("thread-1")).toHaveLength(0);
    const retry = provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    await provider.stopSession("mcode-thread-1");
    await retry;
    expect(resolved).toEqual([
      { requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "turn_ended" } },
      { requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } },
    ]);
    await provider.shutdown();
  });

  it("drains a pending ask on provider failure and shutdown", async () => {
    const http = fakeHttp([shellAsk()]);
    http.promptAsync.mockRejectedValueOnce(new Error("provider failed"));
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    await provider.sendTurn(turnRequest());
    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "turn_ended" } }]);

    const retry = provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });
    await vi.waitFor(() => expect(provider.listPendingApprovals("thread-1")).toHaveLength(1));
    await provider.shutdown();
    await retry;
    expect(resolved).toEqual([
      { requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "turn_ended" } },
      { requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } },
    ]);
  });

  it("invalidates a typed missing reply session instead of resolving approval", async () => {
    const http = fakeHttp([shellAsk()]);
    http.replyPermission.mockRejectedValueOnce(new OpenCodeReplySessionNotFoundError());
    const { provider, submitted } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingApprovals("thread-1")).toHaveLength(1));
    expect(await provider.resolveApproval("per_1", { choiceId: "once" })).toMatchObject({ status: "failed" });
    await sending;

    expect(resolved).toEqual([{ requestId: "per_1", threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } }]);
    const events = submittedEvents(submitted);
    expect(events.filter((event) => event.type === "system" && event.subtype === "sdk_session_invalidated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["cancelled"]);
    await provider.shutdown();
  });
});

const capturedTraceSchema = z.object({ events: z.array(z.unknown()) });

describe("OpenCodeProvider subagent asks", () => {
  const capturedParent = "ses_ed4fbe2b1ffeXhzbidwy7SYFPJ";
  const parentAsk = "per_12b045999001Nz6BidSlAsFs7D";
  const childAsk = "per_12b04d34f0017kQynO4vvCEFBm";

  function childTask(sessionId: string, input: Record<string, unknown>) {
    return {
      type: "message.part.updated",
      properties: { part: { sessionID: "ses_1", type: "tool", tool: "task", callID: "task-1", state: { status: "running", metadata: { sessionId }, input } } },
    };
  }

  function childShellAsk(id: string, sessionID: string) {
    return { type: "permission.v2.asked", properties: { id, sessionID, action: "bash", resources: ["node math.js"], tool: { callID: "child-bash" } } };
  }

  it("cards the captured subagent ask as the subagent's, replies to its session, and drains it on stop", async () => {
    const fixture = capturedTraceSchema.parse(JSON.parse(NodeFS.readFileSync(new URL("./fixtures/task-subagent-permission.captured.json", import.meta.url), "utf8")));
    const http = fakeHttp(fixture.events);
    http.createSession.mockResolvedValue({ id: capturedParent });
    const { provider } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    const resolved: unknown[] = [];
    provider.on("approval_request", (request) => cards.push(request));
    provider.on("approval_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    expect(cards.map((card) => [card.requestId, card.body.toolCallId, card.body.origin])).toEqual([
      [parentAsk, "dd465a06-32c3-425d-b6d1-341cb96ea1b7", { kind: "agent" }],
      [childAsk, "call_00_wxoiedrdv1i13ggek13bwye9", {
        kind: "subagent", label: "Run node math.js once and report output", parentToolCallId: "23a1e412-d94b-44c5-aa4e-2806cde517cc",
      }],
    ]);
    expect(cards.map((card) => [card.body.subject, card.body.choices.find((choice) => choice.id === "always")?.description])).toEqual([
      [{ kind: "command", command: "ls math.js 2>&1 | head -5" }, "ls *, head *"],
      [{ kind: "command", command: "node math.js" }, "node *"],
    ]);

    expect(await provider.resolveApproval(parentAsk, { choiceId: "once" })).toEqual({ status: "resolved" });
    expect(http.replyPermission).toHaveBeenCalledWith(expect.anything(), capturedParent, parentAsk, "once", "legacy", expect.anything());
    await provider.stopSession("mcode-thread-1");
    await sending;
    expect(resolved).toContainEqual({ requestId: childAsk, threadId: "thread-1", outcome: { status: "cancelled", reason: "session_stopped" } });
    expect(provider.listPendingApprovals("thread-1")).toEqual([]);
    await provider.shutdown();
  });

  it("relays a supervised subagent decision to the subagent's own session", async () => {
    const http = fakeHttp([childTask("ses_child", { subagent_type: "general" }), childShellAsk("per_child", "ses_child")]);
    const { provider } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]?.body.origin).toEqual({ kind: "subagent", label: "general", parentToolCallId: "task-1" });
    expect(await provider.resolveApproval("per_child", { choiceId: "reject" })).toEqual({ status: "resolved" });
    expect(http.replyPermission).toHaveBeenCalledWith(expect.anything(), "ses_child", "per_child", "reject", "v2", expect.anything());
    await provider.stopSession("mcode-thread-1");
    await sending;
    await provider.shutdown();
  });

  it("auto-answers a subagent ask in full access and ignores asks from unrelated sessions", async () => {
    const http = fakeHttp([
      childTask("ses_child", { description: "Check the build" }),
      childShellAsk("per_stranger", "ses_stranger"),
      childShellAsk("per_child", "ses_child"),
    ]);
    const { provider, submitted } = testProvider(http);
    const cards: ApprovalRequestEnvelope[] = [];
    provider.on("approval_request", (request) => cards.push(request));

    await provider.sendTurn({ ...turnRequest(), permissionMode: "full" });
    expect(cards).toEqual([]);
    expect(http.replyPermission.mock.calls.map((call) => call.slice(1, 5))).toEqual([["ses_child", "per_child", "always", "v2"]]);
    expect(submittedEvents(submitted).filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["completed"]);
    await provider.shutdown();
  });
});

describe("OpenCodeProvider notice dedup", () => {
  it("keeps diagnostics out of the timeline and shows notices once across reconnects", async () => {
    const unknown = { type: "session.frobnicate", properties: { sessionID: "ses_1" } };
    const reroute = {
      type: "session.next.model.switched",
      properties: { sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
    };
    const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
    const http = fakeHttp([unknown, reroute, idle]);
    const { provider, submitted } = testProvider(http);

    await provider.sendTurn(turnRequest());
    await provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });

    const events = submittedEvents(submitted);
    expect(events.filter((event) => event.type === "system" && event.subtype === "provider.notice.unknown-event")).toEqual([]);
    expect(events.filter((event) => (
      event.type === "modelFallback"
      && event.requestedModel === "anthropic/claude-sonnet-4-6"
      && event.actualModel === "anthropic/claude-sonnet-4-6"
    ))).toHaveLength(1);
    await provider.shutdown();
  });

  it("aborts a native ask with no routing id and publishes no pending request", async () => {
    const http = fakeHttp([{ type: "permission.v2.asked", properties: { sessionID: "ses_1" } }]);
    const { provider, submitted } = testProvider(http);
    const requested = vi.fn();
    const resolved = vi.fn();
    provider.on("approval_request", requested);
    provider.on("approval_resolved", resolved);
    await provider.sendTurn(turnRequest());
    expect(requested.mock.calls).toEqual([]);
    expect(http.abortSession.mock.calls).toEqual([[{ baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1"]]);
    expect(resolved.mock.calls.map(([event]) => ({ threadId: event.threadId, outcome: event.outcome }))).toEqual([
      { threadId: "thread-1", outcome: { status: "cancelled", reason: "unanswerable" } },
    ]);
    expect(provider.listPendingApprovals()).toEqual([]);
    const receipts = submittedEvents(submitted).filter((event) => event.type === "approvalDecided");
    expect(receipts.map((event) => ({ requestId: event.requestId, subjectLabel: event.subjectLabel, outcome: event.outcome }))).toEqual([
      { requestId: resolved.mock.calls[0]?.[0].requestId, subjectLabel: "Mcode couldn't read this request", outcome: { status: "cancelled", reason: "unanswerable" } },
    ]);
    expect(receipts[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await provider.shutdown();
  });

  it("emits oversized resources intact and records an acknowledged automatic denial", async () => {
    const http = fakeHttp([{ type: "permission.v2.asked", properties: { id: "per_large", sessionID: "ses_1", action: "bash", resources: ["x".repeat(70_000)] } }]);
    const { provider, submitted } = testProvider(http);
    const requested = vi.fn();
    const resolved = vi.fn();
    provider.on("approval_request", requested);
    provider.on("approval_resolved", resolved);
    const publishApprovalRequest = vi.fn();
    const publishApprovalResolved = vi.fn();
    const service = new ApprovalService({ resolveAll: () => [provider] });
    service.start({ publishApprovalRequest, publishApprovalResolved, stopSession: async () => provider.stopSession(turnRequest().sessionId) });
    await provider.sendTurn(turnRequest());
    expect(requested.mock.calls[0]?.[0].body.subject).toEqual({ kind: "tool", toolName: "bash", preview: JSON.stringify({ action: "bash", resources: ["x".repeat(70_000)] }) });
    expect(publishApprovalRequest.mock.calls).toEqual([]);
    expect(http.replyPermission.mock.calls.map((args) => args.slice(1, 5))).toEqual([["ses_1", "per_large", "reject", "v2"]]);
    expect(resolved.mock.calls).toEqual([[{ requestId: "per_large", threadId: "thread-1", outcome: { status: "auto_denied", reason: "too_large" } }]]);
    expect(submittedEvents(submitted).filter((event) => event.type === "approvalDecided").map((event) => ({ subjectLabel: event.subjectLabel, outcome: event.outcome })))
      .toEqual([{ subjectLabel: "Mcode couldn't read this request", outcome: { status: "auto_denied", reason: "too_large" } }]);
    await provider.shutdown();
  });

  it("stops an oversized request when its native reject cannot be delivered", async () => {
    const http = fakeHttp([{ type: "permission.v2.asked", properties: { id: "per_large", sessionID: "ses_1", action: "bash", resources: ["x".repeat(70_000)] } }]);
    http.replyPermission.mockRejectedValueOnce(new Error("offline"));
    const { provider, submitted } = testProvider(http);
    const resolved = vi.fn();
    provider.on("approval_resolved", resolved);
    const publishApprovalResolved = vi.fn();
    const service = new ApprovalService({ resolveAll: () => [provider] });
    service.start({ publishApprovalRequest: vi.fn(), publishApprovalResolved, stopSession: async () => provider.stopSession(turnRequest().sessionId) });
    await provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(publishApprovalResolved.mock.calls).toEqual([[{ requestId: "per_large", threadId: "thread-1", outcome: { status: "cancelled", reason: "unanswerable" } }]]));
    expect(provider.listPendingApprovals()).toEqual([]);
    expect(http.abortSession.mock.calls.map((args) => args[1])).toEqual(["ses_1"]);
    expect(submittedEvents(submitted).filter((event) => event.type === "approvalDecided").map((event) => event.outcome))
      .toEqual([{ status: "cancelled", reason: "unanswerable" }]);
    await provider.shutdown();
  });

  it("logs only ids and emits cancellation after a missing-id stop attempt fails", async () => {
    const http = fakeHttp([{ type: "permission.v2.asked", properties: { sessionID: "ses_1" } }]);
    const { provider } = testProvider(http);
    const stopping = Promise.withResolvers<void>();
    const stop = vi.spyOn(provider, "stopSession").mockReturnValueOnce(stopping.promise);
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const resolved = vi.fn();
    provider.on("approval_resolved", resolved);
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(stop.mock.calls).toEqual([[turnRequest().sessionId]]));
    expect(resolved.mock.calls).toEqual([]);
    stopping.reject(new Error("private stop failure"));
    await vi.waitFor(() => expect(resolved.mock.calls.map(([event]) => event.outcome)).toEqual([{ status: "cancelled", reason: "unanswerable" }]));
    expect(log.mock.calls).toEqual([["Failed to stop OpenCode session for an unroutable approval", { providerId: "opencode", sessionId: turnRequest().sessionId, threadId: "thread-1" }]]);
    expect(provider.listPendingApprovals()).toEqual([]);
    stop.mockRestore();
    log.mockRestore();
    await provider.stopSession(turnRequest().sessionId);
    await sending;
    await provider.shutdown();
  });
});
