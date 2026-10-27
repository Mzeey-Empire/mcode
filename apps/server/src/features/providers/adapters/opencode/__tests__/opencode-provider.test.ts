import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { z } from "zod";
import { AgentEventSchema } from "@mcode/contracts/events/agent-event";
import { NativePlanFileRefSchema } from "@mcode/contracts/models/plan";
import { ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import { OpenCodeProvider, toOpenCodeModelRef } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import { defaultOpenCodeHttpClient, type OpenCodeHttpClient } from "../opencode-http-client.js";
import type { TurnRequest } from "@mcode/contracts/providers/interfaces";

function testProvider(http: OpenCodeHttpClient | undefined, pool: OpenCodeServerPool) {
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
    pool,
    ...(http ? { http } : {}),
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
    idleConfirm: { intervalMs: 5, requiredPolls: 2, timeoutMs: 500, maxPollErrors: 2 },
  });
  return { provider, submitted };
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

const submittedBatchSchema = z.object({ events: z.array(z.object({ payload: z.object({ item: z.object({
  payload: z.object({ runtimeEvent: z.object({ event: AgentEventSchema() }) }),
}) }) })) });
const capturedTraceSchema = z.object({ events: z.array(z.unknown()) });
const planBatchSchema = z.object({ events: z.array(z.object({ payload: z.object({ item: z.object({
  payload: z.object({ runtimeEvent: ProviderRuntimeEventSchema() }),
}) }) })) });

function planMessages(submitted: unknown[]) {
  return submitted.flatMap((batch) => planBatchSchema.parse(batch).events.map((event) => event.payload.item.payload.runtimeEvent))
    .filter((runtime) => runtime.event.type === "message");
}

function capturedFile(submitted: unknown[]) {
  return NativePlanFileRefSchema().parse(planMessages(submitted)[0]?.planCapture?.nativePlanFile);
}

function planFilePart(
  filePath: string,
  options: { sessionID?: string; status?: string; tool?: string; existed?: boolean | null } = {},
) {
  const tool = options.tool ?? "write";
  // Captured from OpenCode 1.18.28: `write` reports whether the file existed, `edit` does not.
  const metadata = tool === "write" && options.existed !== null ? { exists: options.existed ?? false } : {};
  return { type: "message.part.updated", properties: { part: {
    type: "tool", id: "part-write", callID: "write-plan", sessionID: options.sessionID ?? "ses_plan",
    tool, state: { status: options.status ?? "completed", input: { filePath }, output: "Written", metadata },
  } } };
}

describe("OpenCode native plans", () => {
  let cwd: string;
  let planRoot: string;
  let path: string;
  const providers: OpenCodeProvider[] = [];

  beforeEach(() => {
    cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-plan-"));
    planRoot = NodePath.join(cwd, ".opencode", "plans");
    NodeFS.mkdirSync(planRoot, { recursive: true });
    path = NodePath.join(planRoot, "session.md");
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.shutdown();
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });

  async function runPlan(
    frames: unknown[],
    request: Partial<TurnRequest<"opencode">> = {},
    beforeFrames = () => NodeFS.writeFileSync(path, "hello"),
  ) {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 4242, on: () => {}, off: () => {}, kill: () => true }),
      waitForHealth: async () => {}, terminateTree: async () => {}, findFreePort: async () => 4096,
      now: () => Date.now(), env: () => ({}),
    });
    const bodies: Record<string, unknown>[] = [];
    const http: OpenCodeHttpClient = { ...defaultOpenCodeHttpClient,
      createSession: async () => ({ id: "ses_plan" }),
      promptAsync: async (_endpoint, _sessionId, body) => { bodies.push(body); },
      abortSession: async () => {}, listSessionMessages: async () => [],
      getSessionStatus: async () => ({ ses_plan: { type: "idle" } }),
      subscribeEvents: async (_endpoint, _signal, onEnvelope) => {
        beforeFrames();
        for (const frame of frames) onEnvelope(frame);
        onEnvelope({ type: "message.part.updated", properties: { sessionID: "ses_plan", part: { type: "text", id: "answer" }, delta: "Plan ready" } });
        onEnvelope({ type: "session.idle", properties: { sessionID: "ses_plan" } });
      },
    };
    const result = testProvider(http, pool);
    providers.push(result.provider);
    await result.provider.sendTurn({ ...turnRequest(), cwd, planTurn: { kind: "planning", planFilePath: null }, ...request });
    return { ...result, bodies };
  }

  it("anchors proved file capture to the final message and leaves git clean after Implement", async () => {
    NodeChildProcess.execFileSync("git", ["init", "--quiet", cwd]);
    const { provider, submitted, bodies } = await runPlan([planFilePart(".opencode/plans/session.md")]);
    expect(NodeChildProcess.execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }).trim()).toBe("?? .opencode/");
    expect(bodies).toEqual([{ agent: "plan", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" }, parts: [{ type: "text", text: "hello" }] }]);
    expect(planMessages(submitted)).toMatchObject([{ event: { type: "message", content: "Plan ready" }, planCapture: {
      source: "native", markdown: "hello", nativePlanFile: { path, sessionId: "ses_plan",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    } }]);
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "edited plan", nativePlanFile: capturedFile(submitted) }))
      .toEqual({ outcome: "deleted" });
    expect(NodeFS.existsSync(path)).toBe(false);
    expect(NodeFS.statSync(planRoot).isDirectory()).toBe(true);
    expect(NodeChildProcess.execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("deletes only the owned file, leaving another session's plan untouched", async () => {
    const other = NodePath.join(planRoot, "other.md");
    NodeFS.writeFileSync(other, "Other session plan");
    const { provider, submitted } = await runPlan([
      planFilePart(path),
      planFilePart(other, { tool: "edit" }),
      planFilePart(other, { sessionID: "ses_other" }),
    ]);
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: capturedFile(submitted) }))
      .toEqual({ outcome: "deleted" });
    expect(NodeFS.existsSync(path)).toBe(false);
    expect(NodeFS.readFileSync(other, "utf8")).toBe("Other session plan");
  });

  it("leaves a file edited after capture and reports changed", async () => {
    const { provider, submitted } = await runPlan([planFilePart(path)]);
    NodeFS.writeFileSync(path, "HELLO");
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: capturedFile(submitted) }))
      .toEqual({ outcome: "skipped", reason: "changed" });
    expect(NodeFS.readFileSync(path, "utf8")).toBe("HELLO");
  });

  it.each(["write", "edit"])("leaves a pre-existing file after the session uses %s", async (tool) => {
    NodeFS.writeFileSync(path, "Existing plan");
    const { submitted } = await runPlan([planFilePart(path, { tool, existed: true })], {}, () => {});

    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
    expect(NodeFS.readFileSync(path, "utf8")).toBe("Existing plan");
  });

  it("does not claim a write that omits the exists flag", async () => {
    const { submitted } = await runPlan([planFilePart(path, { existed: null })]);

    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
  });

  it("does not claim a file the session only edited", async () => {
    const { submitted } = await runPlan([planFilePart(path, { tool: "edit" })]);

    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
  });

  it("forgets a deleted file so a recreated file of the same name is not claimed", async () => {
    const frames = [planFilePart(path)];
    const { provider, submitted } = await runPlan(frames, {}, () => NodeFS.writeFileSync(path, "hello"));
    expect(await provider.prepareImplement({
      threadId: "thread-1", markdown: "hello", nativePlanFile: capturedFile(submitted),
    })).toEqual({ outcome: "deleted" });
    submitted.length = 0;
    frames[0] = planFilePart(path, { tool: "edit" });

    await provider.sendTurn({
      ...turnRequest(), cwd,
      turnId: "turn-2", turnExecutionId: "22222222-2222-4222-8222-222222222222",
      planTurn: { kind: "planning", planFilePath: null },
    });

    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
  });

  it("captures a file when the plan root did not exist before the turn", async () => {
    NodeFS.rmdirSync(planRoot);
    const { submitted } = await runPlan([planFilePart(path)], {}, () => {
      NodeFS.mkdirSync(planRoot);
      NodeFS.writeFileSync(path, "hello");
    });

    expect(planMessages(submitted)).toMatchObject([{
      planCapture: { source: "native", markdown: "hello", nativePlanFile: { path, sessionId: "ses_plan" } },
    }]);
  });

  it("captures a session-created file again when a later turn edits it", async () => {
    const frames = [planFilePart(path)];
    let markdown = "hello";
    const { provider, submitted } = await runPlan(frames, {}, () => NodeFS.writeFileSync(path, markdown));
    expect(capturedFile(submitted).path).toBe(path);
    submitted.length = 0;
    markdown = "Revised plan";
    frames[0] = planFilePart(path, { tool: "edit" });

    await provider.sendTurn({
      ...turnRequest(), cwd,
      turnId: "turn-2", turnExecutionId: "22222222-2222-4222-8222-222222222222",
      planTurn: { kind: "planning", planFilePath: null },
    });

    expect(planMessages(submitted)).toMatchObject([{
      planCapture: { source: "native", markdown: "Revised plan", nativePlanFile: { path, sessionId: "ses_plan" } },
    }]);
    expect(await provider.prepareImplement({
      threadId: "thread-1", markdown, nativePlanFile: capturedFile(submitted),
    })).toEqual({ outcome: "deleted" });
    expect(NodeFS.existsSync(path)).toBe(false);
  });

  it("refuses a symlink substituted after capture", async () => {
    const { provider, submitted } = await runPlan([planFilePart(path)]);
    const target = NodePath.join(planRoot, "other.md");
    NodeFS.renameSync(path, target);
    NodeFS.symlinkSync(target, path, "file");
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: capturedFile(submitted) }))
      .toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(NodeFS.readFileSync(target, "utf8")).toBe("hello");
    expect(NodeFS.lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("refuses a reference outside the session's known plan root", async () => {
    const { provider, submitted } = await runPlan([planFilePart(path)]);
    const outside = NodePath.join(cwd, "outside.md");
    NodeFS.writeFileSync(outside, "hello");
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: { ...capturedFile(submitted), path: outside } }))
      .toEqual({ outcome: "skipped", reason: "unsafe-path" });
    expect(NodeFS.readFileSync(outside, "utf8")).toBe("hello");
  });

  it("refuses wrong-session references and references whose session state was lost", async () => {
    const { provider, submitted } = await runPlan([planFilePart(path)]);
    const ref = capturedFile(submitted);
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: { ...ref, sessionId: "ses_other" } }))
      .toEqual({ outcome: "skipped", reason: "unproven" });
    expect(await provider.prepareImplement({ threadId: "unknown-thread", markdown: "hello", nativePlanFile: ref }))
      .toEqual({ outcome: "skipped", reason: "unproven" });
    await provider.discardSession("mcode-thread-1");
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: ref }))
      .toEqual({ outcome: "skipped", reason: "unproven" });
    expect(NodeFS.readFileSync(path, "utf8")).toBe("hello");
    expect(await provider.prepareImplement({ threadId: "thread-1", markdown: "hello", nativePlanFile: null }))
      .toEqual({ outcome: "skipped", reason: "no-file" });
  });

  it("claims nothing when the project is a subfolder of the git root OpenCode writes plans under", async () => {
    const projectDir = NodePath.join(cwd, "sub", "app");
    NodeFS.mkdirSync(projectDir, { recursive: true });
    const { submitted } = await runPlan(
      [planFilePart(path, { sessionID: "ses_plan", status: "completed", tool: "write", existed: false })],
      { cwd: projectDir },
    );
    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
    expect(NodeFS.readFileSync(path, "utf8")).toBe("hello");
  });

  it.each(["build", "outside", "other-session", "running", "read", "no-tool", "missing"])("does not capture a native file for %s evidence", async (kind) => {
    const candidate = kind === "outside" ? NodePath.join(cwd, "outside.md") : path;
    if (kind === "outside") NodeFS.writeFileSync(candidate, "hello");
    const frames = kind === "no-tool" ? [] : [planFilePart(candidate, {
      sessionID: kind === "other-session" ? "other" : "ses_plan",
      status: kind === "running" ? "running" : "completed", tool: kind === "read" ? "read" : "write",
    })];
    const { submitted, bodies } = await runPlan(
      frames,
      kind === "build" ? { planTurn: undefined } : {},
      () => {
        if (kind !== "missing") NodeFS.writeFileSync(path, "hello");
      },
    );
    expect(planMessages(submitted).map((runtime) => runtime.planCapture)).toEqual([undefined]);
    expect(bodies.map((body) => body.agent)).toEqual([kind === "build" ? undefined : "plan"]);
  });
});

async function replaySubagentFrames(frames: unknown[], parentSessionId: string, promptError?: Error) {
  const pool = new OpenCodeServerPool({
    spawn: () => ({ pid: 4242, on: () => {}, off: () => {}, kill: () => true }),
    waitForHealth: async () => {}, terminateTree: async () => {}, findFreePort: async () => 4096,
    now: () => Date.now(), env: () => ({}),
  });
  const status = vi.fn(async () => ({ [parentSessionId]: { type: "idle" } }));
  const http: OpenCodeHttpClient = { ...defaultOpenCodeHttpClient,
    createSession: async () => ({ id: parentSessionId }),
    promptAsync: async () => { if (promptError) throw promptError; }, abortSession: async () => {},
    listSessionMessages: async () => [], getSessionStatus: status,
    subscribeEvents: async (_endpoint, _signal, onEnvelope) => { for (const frame of frames) onEnvelope(frame); },
  };
  const { provider, submitted } = testProvider(http, pool);
  try {
    await provider.sendTurn(turnRequest());
    const events = submitted.flatMap((batch) => submittedBatchSchema.parse(batch).events.map((event) => event.payload.item.payload.runtimeEvent.event));
    return { events, statusCalls: status.mock.calls.length };
  } finally {
    await provider.shutdown();
  }
}

describe("OpenCode failed turns", () => {
  it.each([
    { name: "ProviderAuthError", data: { providerID: "anthropic", message: "Login expired" }, failure: { kind: "auth", code: "ProviderAuthError" } },
    { name: "APIError", data: { message: "Service unavailable", statusCode: 503, isRetryable: false }, failure: { kind: "retryable", status: 503, code: "APIError" } },
    { name: "APIError", data: { message: "Connection reset", isRetryable: true }, failure: { kind: "retryable", code: "APIError" } },
    { name: "APIError", data: { message: "Quota exhausted", statusCode: 429, isRetryable: true }, failure: { kind: "usage_limit", status: 429, code: "APIError" } },
    { name: "APIError", data: { message: "Too many requests", statusCode: 429, isRetryable: false }, failure: { kind: "retryable", status: 429, code: "APIError" } },
    { name: "APIError", data: { message: "Invalid request", statusCode: 400, isRetryable: false }, failure: { kind: "fatal", status: 400, code: "APIError" } },
    { name: "UnknownError", data: { message: "" }, expectedError: "UnknownError", failure: { kind: "fatal", code: "UnknownError" } },
    { name: "UnknownError", data: { message: " \t\n" }, expectedError: "UnknownError", failure: { kind: "fatal", code: "UnknownError" } },
    { name: "APIError", data: { message: " \t\n", statusCode: 503 }, expectedError: "APIError", failure: { kind: "retryable", status: 503, code: "APIError" } },
    { name: " ", data: { message: "" }, expectedError: "OpenCode session error", failure: { kind: "fatal" } },
    { name: "APIError", data: { message: "Bad metadata", statusCode: "503", isRetryable: "true" }, failure: { kind: "fatal", code: "APIError" } },
  ])("emits one classified error for $name: $data.message", async ({ name, data, expectedError, failure }) => {
    const frame = { type: "session.error", properties: { sessionID: "ses_parent", error: { name, data } } };
    const { events } = await replaySubagentFrames([frame, frame, { type: "session.idle", properties: { sessionID: "ses_parent" } }], "ses_parent");
    expect(events.filter((event) => event.type === "error").map((event) => ({ error: event.error, failure: event.failure })))
      .toEqual([{ error: expectedError ?? data.message, failure }]);
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["errored"]);
    expect(events.filter((event) => event.type === "turnComplete")).toEqual([]);
  });

  it.each(["", " \t\n"])("uses fallback text for a thrown blank message %j", async (message) => {
    const { events } = await replaySubagentFrames([], "ses_parent", new Error(message));
    expect(events.filter((event) => event.type === "error").map((event) => ({ error: event.error, failure: event.failure })))
      .toEqual([{ error: "OpenCode session error", failure: { kind: "fatal" } }]);
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["errored"]);
    expect(events.filter((event) => event.type === "turnComplete")).toEqual([]);
  });

  it("classifies the HTTP client's thrown status and keeps its message", async () => {
    const message = "OpenCode prompt_async failed with HTTP 503";
    const { events } = await replaySubagentFrames([], "ses_parent", new Error(message));
    expect(events.filter((event) => event.type === "error").map((event) => ({ error: event.error, failure: event.failure })))
      .toEqual([{ error: message, failure: { kind: "retryable", status: 503 } }]);
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["errored"]);
  });

  it.each([{ next: 1_800_000_008_000, delayMs: 8_000 }, { next: 1_799_999_999_000, delayMs: 0 }])(
    "forwards a retry status with delay $delayMs before a single terminal failure", async ({ next, delayMs }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const { events } = await replaySubagentFrames([
          { type: "session.status", properties: { sessionID: "ses_parent", status: { type: "retry", attempt: 2, message: "Service unavailable", next } } },
          { type: "session.error", properties: { sessionID: "ses_parent", error: { name: "APIError", data: { message: "Retries exhausted", statusCode: 503, isRetryable: true } } } },
        ], "ses_parent");
        expect(events.filter((event) => event.type === "apiRetry").map((event) => ({ reason: event.reason, attempt: event.attempt, delayMs: event.delayMs })))
          .toEqual([{ reason: "Service unavailable", attempt: 2, delayMs }]);
        expect(events.filter((event) => ["apiRetry", "error", "ended"].includes(event.type)).map((event) => event.type))
          .toEqual(["apiRetry", "error", "ended"]);
      } finally { clock.mockRestore(); }
    },
  );
});

describe("OpenCode subagent routing", () => {
  it("replays the captured child reads into one parent turn without child text", async () => {
    const fixture = capturedTraceSchema.parse(JSON.parse(NodeFS.readFileSync(new URL("./fixtures/task-subagent.captured.json", import.meta.url), "utf8")));
    const { events } = await replaySubagentFrames(fixture.events, "ses_ed6efea1affe2u8G8ghj63ppt2");
    const tools = events.filter((event) => event.type === "toolUse");
    expect([...new Set(tools.filter((event) => event.toolName === "Agent").map((event) => event.toolCallId))]).toEqual(["call_00_xr57hsrx9heom9avd50vi5bk"]);
    expect([...new Set(tools.filter((event) => event.toolName === "read").map((event) => `${event.toolCallId}:${event.parentToolCallId}`))]).toEqual([
      "call_00_gklh7p1tknyzzv94mr7cglmz:call_00_xr57hsrx9heom9avd50vi5bk",
      "call_01_pnjs9yz5shlnirmegim4j9oa:call_00_xr57hsrx9heom9avd50vi5bk",
    ]);
    expect(events.filter((event) => event.type === "toolResult" && event.parentToolCallId).map((event) => event.toolCallId)).toEqual([
      "call_00_gklh7p1tknyzzv94mr7cglmz", "call_01_pnjs9yz5shlnirmegim4j9oa",
    ]);
    expect(events.filter((event) => event.type === "toolResult" && !event.parentToolCallId).map((event) => event.output)).toEqual(["`add`"]);
    expect(events.filter((event) => event.type === "textDelta").map((event) => event.delta).join("")).toBe(
      "The subagent read both files and reported the exported function is `add`.",
    );
    const reasoning = events.filter((event) => event.type === "reasoningDelta");
    expect(reasoning.map((event) => event.delta).join("")).toBe(
      "Let me first check the files exist. Actually the task is clear: use task tool once to launch general subagent, then reply one short sentence.\n\nLet me look at the working directory. I'll just launch the subagent.\n\nBut the subagent needs to find math.js and README.md. Let me just launch it.",
    );
    expect([...new Set(reasoning.map((event) => event.reasoningItemId))]).toEqual(["prt_129103aa9001D2P8QF9Dn73cr4"]);
    expect(reasoning.at(-1)).toMatchObject({ delta: "", done: true });
    expect(events.filter((event) => event.type === "turnComplete").map((event) => event.reason)).toEqual(["end_turn"]);
  });

  it("keeps nested tasks attached to their own call and ignores child lifecycle and unrelated sessions", async () => {
    const tool = (sessionID: string, toolName: string, callID: string, state: Record<string, unknown>) => ({
      type: "message.part.updated", properties: { part: { sessionID, type: "tool", tool: toolName, callID, state } },
    });
    const { events, statusCalls } = await replaySubagentFrames([
      tool("ses_parent", "task", "outer", { status: "running", metadata: { sessionId: "child" }, input: { description: "Outer" } }),
      tool("child", "task", "inner", { status: "running", metadata: { sessionId: "grandchild" }, input: { description: "Inner" } }),
      tool("grandchild", "read", "read", { status: "running" }),
      tool("grandchild", "read", "read", { status: "error", error: "Read failed" }),
      tool("stranger", "read", "foreign", { status: "running" }),
      { type: "message.part.delta", properties: { sessionID: "child", messageID: "child-message", delta: "private child text" } },
      { type: "session.idle", properties: { sessionID: "child" } },
      { type: "session.error", properties: { sessionID: "child", error: { name: "ChildError" } } },
      { type: "session.status", properties: { sessionID: "grandchild", status: { type: "idle" } } },
      { type: "message.part.updated", properties: { part: { sessionID: "child", type: "step-finish" } } },
    ], "ses_parent");
    expect(events.filter((event) => event.type === "toolUse").map((event) => [event.toolCallId, event.parentToolCallId])).toEqual([
      ["outer", undefined], ["inner", "outer"], ["read", "inner"],
    ]);
    expect(events.filter((event) => event.type === "toolResult")).toMatchObject([{ toolCallId: "read", parentToolCallId: "inner", output: "Read failed", isError: true }]);
    expect(events.filter((event) => event.type === "textDelta" || event.type === "turnComplete")).toEqual([]);
    // Closing the stream without a parent idle must fail instead of accepting a child's idle as completion.
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["errored"]);
    expect(statusCalls).toBe(0);
  });
});

describe("toOpenCodeModelRef", () => {
  it("splits provider/model slugs", () => {
    expect(toOpenCodeModelRef("opencode/muse-spark-1.3-contributor-free")).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
  });

  it("passes bare ids as model-only and blanks as undefined", () => {
    expect(toOpenCodeModelRef("gpt-5")).toEqual({ modelID: "gpt-5" });
    expect(toOpenCodeModelRef("  ")).toBeUndefined();
    expect(toOpenCodeModelRef(undefined)).toBeUndefined();
  });
});

describe("OpenCodeProvider minimal turn", () => {
  it("does not finish shutdown until its server has terminated", async () => {
    let releaseTermination = () => {};
    let signalTerminationStarted = () => {};
    const terminationStarted = new Promise<void>((resolve) => { signalTerminationStarted = resolve; });
    const terminationAllowed = new Promise<void>((resolve) => { releaseTermination = resolve; });
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 4242, on: () => {}, off: () => {}, kill: () => true }),
      waitForHealth: async () => {},
      terminateTree: async () => {
        signalTerminationStarted();
        await terminationAllowed;
      },
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" });
    const { provider } = testProvider(undefined, pool);

    let completed = false;
    const shutdown = provider.shutdown().then(() => { completed = true; });
    await terminationStarted;
    expect(completed).toBe(false);

    releaseTermination();
    await shutdown;
    expect(completed).toBe(true);
  });

  it("streams a reply to completion and returns the pool server warm", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_1" })),
      promptAsync: vi.fn(async () => {}),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      listSessionMessages: vi.fn(async () => []),
      getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "message.part.updated", properties: { sessionID: "ses_1", part: { type: "text", id: "p1" }, delta: "hi" } });
        onEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } });
      }),
    };
    const { provider, submitted } = testProvider(http as never, pool);
    const events: unknown[] = [];
    provider.on("event", (e) => events.push(e));
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:4096", directory: "/w/a" }, "ses_1", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    });
    expect(pool.size).toBe(1);
    expect(submitted.length).toBeGreaterThan(0);
    await provider.shutdown();
  });

  it("stop aborts the upstream session and settles as cancelled with no further output", async () => {
    let captured: ((e: unknown) => void) | null = null;
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_9" })),
      promptAsync: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
      }),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      listSessionMessages: vi.fn(async () => []),
      getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
      subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        captured = onEnvelope;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    const sending = provider.sendTurn(turnRequest());
    await new Promise((r) => setTimeout(r, 10));
    await provider.stopSession("mcode-thread-1");
    captured?.({ type: "message.part.updated", properties: { sessionID: "ses_9", part: { type: "text", id: "p1" }, delta: "late" } });
    await sending;
    expect(http.abortSession).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);
    await provider.shutdown();
  });

  it("starts fresh once when the adopted upstream session is gone (404)", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    let sessions = 0;
    const http = {
      createSession: vi.fn(async () => ({ id: `ses_fresh_${++sessions}` })),
      promptAsync: vi.fn(async (_url: string, sessionId: string) => {
        if (sessionId === "ses_stale") throw new Error("OpenCode prompt_async failed with HTTP 404");
      }),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      listSessionMessages: vi.fn(async () => []),
      getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "session.idle", properties: { sessionID: `ses_fresh_${sessions}` } });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    await provider.sendTurn(turnRequest());
    // First turn adopts and caches ses_fresh_1.
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(1);
    // Simulate the cached session disappearing upstream, then send again:
    // the provider must recreate once instead of erroring.
    (provider as unknown as { turns: Map<string, { upstreamSessionId: string }> })
      .turns.get("mcode-thread-1")!.upstreamSessionId = "ses_stale";
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(2);
    await provider.shutdown();
  });

  it("discardSession drops the adopted upstream session", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_1" })),
      promptAsync: vi.fn(async () => {}),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      listSessionMessages: vi.fn(async () => []),
      getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    await provider.sendTurn(turnRequest());
    await provider.discardSession("mcode-thread-1");
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(2);
    await provider.shutdown();
  });
});
