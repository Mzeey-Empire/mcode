import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanUseTool, query } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { ApprovalRequestBodySchema, type ApprovalRequestEnvelope, type ApprovalOrigin, type ApprovalSubject } from "@mcode/contracts/models/approval";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { ClaudeProvider, stubEnvService, stubJobObject } from "./helpers/provider-fixture.js";
import { queryMethodStubs } from "./helpers/mock-sdk-query.js";

type FilePatch = Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number];

const { mockQuery, mockFilePatch } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockFilePatch: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("../claude-approval-patch.js", () => ({ claudeFilePatch: mockFilePatch }));

describe("Claude approval origin", () => {
  let provider: ClaudeProvider;
  const requests: ApprovalRequestEnvelope[] = [];

  beforeEach(() => {
    requests.length = 0;
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    provider.on("approval_request", (request) => requests.push(request));
  });

  afterEach(async () => { await provider.shutdown(); });

  async function startTurn(threadId: string, messages: Record<string, unknown>[], queuedMessages?: AsyncIterable<Record<string, unknown>>): Promise<CanUseTool> {
    let ready: (callback: CanUseTool) => void = () => {};
    const callback = new Promise<CanUseTool>((resolve) => { ready = resolve; });
    mockQuery.mockImplementation(({ prompt, options }: Parameters<typeof query>[0]) => {
      if (typeof prompt === "string" || !options?.canUseTool) throw new Error("Expected streaming SDK query");
      const canUseTool = options.canUseTool;
      let finish = () => {};
      const closed = new Promise<void>((resolve) => { finish = resolve; });
      async function* stream() {
        for await (const _message of prompt) {
          yield* messages;
          ready(canUseTool);
          if (queuedMessages) yield* queuedMessages;
          await closed;
          return;
        }
      }
      return Object.assign(stream(), queryMethodStubs(), { close: finish });
    });
    await provider.sendTurn({
      turnExecutionId: `execution-${threadId}`, sessionId: `mcode-${threadId}`, threadId,
      message: "Print the date", cwd: process.cwd(), model: "claude-sonnet-4-6",
      permissionMode: "supervised", interactionMode: "build", providerOptions: {},
    });
    return callback;
  }

  function taskStarted(description: string, taskId = "ab6ba61b35d02c4b7", toolUseId = "toolu_016k") {
    return { type: "system", subtype: "task_started", task_id: taskId,
      tool_use_id: toolUseId, description, task_type: "local_agent" };
  }

  async function requestOrigin(canUseTool: CanUseTool, agentID?: string): Promise<ApprovalOrigin> {
    const count = requests.length;
    const decision = canUseTool("Bash", { command: "date" }, {
      signal: new AbortController().signal, toolUseID: "toolu_015R", requestId: "native-request", agentID,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(count + 1));
    const request = requests[count];
    const body = ApprovalRequestBodySchema().parse(request.body);
    expect(await provider.resolveApproval(request.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
    expect(await decision).toMatchObject({ behavior: "deny" });
    return body.origin;
  }

  it("joins the SDK agent ID to its task description and spawning tool, without labeling the parent", async () => {
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event) => events.push(event));
    const canUseTool = await startTurn("parent", [
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use",
        id: "toolu_016k", name: "Agent", input: { description: "Print date", subagent_type: "general-purpose", prompt: "Run date" } }] } },
      taskStarted("Print date"),
      taskStarted("Inspect files", "other-child", "other-spawn"),
      { type: "assistant", parent_tool_use_id: "toolu_016k", message: { content: [{ type: "tool_use",
        id: "toolu_015R", name: "Bash", input: { command: "date" } }] } },
    ]);
    expect(await requestOrigin(canUseTool, "ab6ba61b35d02c4b7")).toEqual({
      kind: "subagent", label: "Print date", parentToolCallId: "toolu_016k",
    });
    await vi.waitFor(() => expect(events.filter(({ event }) => event.type === AgentEventType.ApprovalDecided)).toMatchObject([{
      event: { origin: { kind: "subagent", label: "Print date", parentToolCallId: "toolu_016k" } },
    }]));
    expect(await requestOrigin(canUseTool)).toEqual({ kind: "agent" });
  });

  it("keeps an unidentified child honest without borrowing another child's label", async () => {
    const canUseTool = await startTurn("unknown", [taskStarted("Print date")]);
    expect(await requestOrigin(canUseTool, "unseen-child")).toEqual({ kind: "subagent", label: "Subagent" });
  });

  it("enriches every pending request for the task, without updating another agent or thread", async () => {
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event) => events.push(event));
    let releaseTask = () => {};
    const taskReady = new Promise<void>((resolve) => { releaseTask = resolve; });
    let finishTask = () => {};
    const taskConsumed = new Promise<void>((resolve) => { finishTask = resolve; });
    async function* queuedMessages() {
      await taskReady;
      yield taskStarted("Print date");
      finishTask();
    }
    const canUseTool = await startTurn("parent", [], queuedMessages());
    const otherThread = await startTurn("other-thread", []);
    const decisions: ReturnType<CanUseTool>[] = [];
    for (const [index, callback] of [canUseTool, canUseTool, canUseTool, otherThread].entries()) {
      decisions.push(callback("Bash", { command: "date" }, {
        signal: new AbortController().signal, toolUseID: `tool-${index}`, requestId: `native-${index}`,
        agentID: index === 2 ? "other-child" : "ab6ba61b35d02c4b7",
      }));
      await vi.waitFor(() => expect(requests).toHaveLength(index + 1));
    }
    const originals = requests.slice();
    expect(originals.map(({ body }) => ApprovalRequestBodySchema().parse(body).origin)).toEqual([
      { kind: "subagent", label: "Subagent" }, { kind: "subagent", label: "Subagent" },
      { kind: "subagent", label: "Subagent" }, { kind: "subagent", label: "Subagent" },
    ]);

    releaseTask();
    await taskConsumed;
    expect(requests).toHaveLength(6);
    const origin: ApprovalOrigin = { kind: "subagent", label: "Print date", parentToolCallId: "toolu_016k" };
    expect(requests.slice(4)).toEqual(originals.slice(0, 2).map((request) => ({
      ...request, body: { ...request.body, origin },
    })));
    for (const [index, request] of originals.entries()) {
      expect(await provider.resolveApproval(request.requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
      expect(await decisions[index]).toMatchObject({ behavior: "deny" });
    }
    await vi.waitFor(() => expect(events.filter(({ event }) => event.type === AgentEventType.ApprovalDecided)).toMatchObject([
      { event: { origin } }, { event: { origin } },
      { event: { origin: { kind: "subagent", label: "Subagent" } } },
      { event: { origin: { kind: "subagent", label: "Subagent" } } },
    ]));
    expect(provider.listPendingApprovals()).toEqual([]);
  });

  it.each([
    { description: "x".repeat(201), label: "x".repeat(200) },
    { description: "   ", label: "Subagent" },
  ])("bounds the task description for approval validation: $label", async ({ description, label }) => {
    const canUseTool = await startTurn("bounded", [taskStarted(description)]);
    expect(await requestOrigin(canUseTool, "ab6ba61b35d02c4b7")).toEqual({
      kind: "subagent", label, parentToolCallId: "toolu_016k",
    });
  });

  it("labels a file approval whose task starts while its patch is still loading", async () => {
    let releasePatch: (patch: FilePatch) => void = () => {};
    mockFilePatch.mockReturnValueOnce(new Promise<FilePatch>((resolve) => { releasePatch = resolve; }));
    let releaseTask = () => {};
    const taskReady = new Promise<void>((resolve) => { releaseTask = resolve; });
    let finishTask = () => {};
    const taskConsumed = new Promise<void>((resolve) => { finishTask = resolve; });
    async function* queuedMessages() {
      await taskReady;
      yield taskStarted("Print date");
      finishTask();
    }
    const canUseTool = await startTurn("held", [], queuedMessages());
    const decision = canUseTool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, {
      signal: new AbortController().signal, toolUseID: "toolu_015R", requestId: "native-request", agentID: "ab6ba61b35d02c4b7",
    });
    await vi.waitFor(() => expect(mockFilePatch).toHaveBeenCalled());
    releaseTask();
    await taskConsumed;
    releasePatch({ path: "a.ts", change: "edited", additions: 1, deletions: 1 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(ApprovalRequestBodySchema().parse(requests[0].body).origin).toEqual({
      kind: "subagent", label: "Print date", parentToolCallId: "toolu_016k",
    });
    expect(await provider.resolveApproval(requests[0].requestId, { choiceId: "deny" })).toEqual({ status: "resolved" });
    expect(await decision).toMatchObject({ behavior: "deny" });
  });
});
