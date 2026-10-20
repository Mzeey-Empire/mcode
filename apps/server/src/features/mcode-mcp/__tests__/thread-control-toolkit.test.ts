import { describe, expect, it, vi } from "vitest";
import {
  ThreadCreateBatchResultSchema,
  ThreadGetResultSchema,
  ThreadSearchResultSchema,
  ThreadSendResultSchema,
  ThreadStopResultSchema,
  ThreadWaitResultSchema,
  WorkspaceSearchResultSchema,
  WorktreeListResultSchema,
} from "@mcode/contracts";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McodeSessionAuthority, type McodeSession } from "../mcode-session-authority.js";
import { createThreadControlToolkit, type ThreadControlToolService } from "../toolkits/thread-control-toolkit.js";

const session: McodeSession = {
  providerId: "claude",
  sessionId: "pooled-provider-session",
  threadId: "source-thread",
  threadControl: true,
};

const DENIED = "Internal thread-control MCP request denied";

const thread = {
  workspaceId: "workspace-1",
  threadId: "destination-thread",
  title: "Destination",
  providerId: "claude",
  modelId: "claude-model",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  state: { status: "running" },
};

const execution = {
  providerId: "claude",
  modelId: "claude-sonnet-4-6",
  permissionMode: "full",
  interactionMode: "build",
} as const;

function createService() {
  return {
    workspaceSearch: vi.fn<ThreadControlToolService["workspaceSearch"]>(),
    worktreeList: vi.fn<ThreadControlToolService["worktreeList"]>(),
    threadCreateBatch: vi.fn<ThreadControlToolService["threadCreateBatch"]>(),
    threadTargetList: vi.fn<ThreadControlToolService["threadTargetList"]>(),
    threadSearch: vi.fn<ThreadControlToolService["threadSearch"]>(),
    threadGet: vi.fn<ThreadControlToolService["threadGet"]>(),
    threadSend: vi.fn<ThreadControlToolService["threadSend"]>(),
    threadStop: vi.fn<ThreadControlToolService["threadStop"]>(),
    threadWait: vi.fn<ThreadControlToolService["threadWait"]>(),
  } satisfies ThreadControlToolService;
}

function setup(options: { lease?: "active" | "ineligible" | "none"; threadControl?: boolean } = {}) {
  const authority = new McodeSessionAuthority();
  const lease = options.lease ?? "active";
  if (lease !== "none") {
    authority.activate({
      sessionId: session.sessionId,
      sourceThreadId: session.threadId,
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "full",
      eligible: lease === "active",
    });
  }
  const service = createService();
  const boundSession = { ...session, threadControl: options.threadControl ?? true };
  const bound = createThreadControlToolkit({ authority, service }).bind(boundSession);

  function call(
    name: string,
    args: unknown = {},
    context: { toolCallId?: string; signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    const tool = bound?.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} is not bound`);
    return tool.call(args, {
      toolCallId: context.toolCallId ?? "call-1",
      signal: context.signal ?? new AbortController().signal,
    });
  }

  return { authority, service, bound, call };
}

function waitUntilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

const timedOutWait = () => ThreadWaitResultSchema().parse({
  status: "success",
  timedOut: true,
  results: [{ workspaceId: "workspace-1", threadId: "destination-thread", state: { status: "running" } }],
});

describe("thread-control toolkit", () => {
  it("dispatches workspace_search with the lease's source thread and the call id, applying defaults", async () => {
    const { call, service } = setup();
    service.workspaceSearch.mockReturnValue(WorkspaceSearchResultSchema().parse({ workspaces: [] }));

    const result = await call("workspace_search", { query: "mcode" }, { toolCallId: "call-1" });

    expect(result.structuredContent).toEqual({ workspaces: [] });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ workspaces: [] }) }]);
    expect(service.workspaceSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceThreadId: "source-thread", sourceToolCallId: "call-1" }),
      { query: "mcode", limit: 20 },
    );
  });

  it("lists the eleven tools in order, with the guides first and no listed output for worktree_list", () => {
    const { bound } = setup({ lease: "none" });

    const tools = bound?.tools.filter((tool) => tool.listed) ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcode_browser_guide",
      "thread_control_guide",
      "workspace_search",
      "worktree_list",
      "thread_create_batch",
      "thread_target_list",
      "thread_search",
      "thread_get",
      "thread_send",
      "thread_stop",
      "thread_wait",
    ]);
    expect(tools.find((tool) => tool.name === "worktree_list")?.outputSchema).toBeUndefined();
    expect(tools.find((tool) => tool.name === "workspace_search")?.outputSchema).toBeDefined();
  });

  it("lists nothing when the session was attached without thread control", () => {
    expect(setup({ threadControl: false }).bound).toBeNull();
  });

  it.each(["none", "ineligible"] as const)("refuses every call when the turn lease is %s", async (lease) => {
    const { call, service } = setup({ lease });

    await expect(call("workspace_search", { query: "mcode" })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: DENIED }],
    });
    await expect(call("thread_control_guide")).resolves.toMatchObject({ isError: true });
    expect(service.workspaceSearch).not.toHaveBeenCalled();
  });

  it("fails closed once the lease is revoked", async () => {
    const { authority, call, service } = setup();
    service.worktreeList.mockResolvedValue(WorktreeListResultSchema().parse({
      status: "found",
      workspaceId: "workspace-1",
      worktrees: [{ worktreeId: "worktree-1", label: "main", branch: "main" }],
    }));

    await expect(call("worktree_list", { workspaceId: "workspace-1" })).resolves.toMatchObject({
      structuredContent: { status: "found", workspaceId: "workspace-1" },
    });
    authority.revoke(session.sessionId);
    await expect(call("worktree_list", { workspaceId: "workspace-1" })).resolves.toMatchObject({ isError: true });
    expect(service.worktreeList).toHaveBeenCalledTimes(1);
  });

  it("answers an unauthorized call with the denial before it validates the arguments", async () => {
    const { call } = setup({ lease: "none" });

    await expect(call("thread_search", { statuses: [] })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: DENIED }],
    });
  });

  it.each([
    ["workspace_search", { sourceThreadId: "forged" }],
    ["thread_send", { threadId: "destination-thread", message: "Forged", sourceThreadId: "source-thread" }],
    ["thread_stop", { threadId: "destination-thread", sourceThreadId: "source-thread" }],
    ["thread_wait", { threadIds: ["duplicate", "duplicate"] }],
    ["thread_search", { statuses: [] }],
  ])("rejects invalid %s arguments as InvalidParams without calling the service", async (name, args) => {
    const { call, service } = setup();

    await expect(call(name, args)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining(`Input validation error: Invalid arguments for tool ${name}: `),
    });
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it("dispatches thread_create_batch with the call id", async () => {
    const { call, service } = setup();
    service.threadCreateBatch.mockResolvedValue(ThreadCreateBatchResultSchema().parse({
      results: [{
        index: 0,
        status: "created",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        turnId: "turn-1",
        execution,
        placement: { type: "direct" },
        state: { status: "starting" },
      }],
    }));

    const result = await call("thread_create_batch", {
      items: [{
        workspaceId: "workspace-1",
        title: "Delegated thread",
        prompt: "Implement the task.",
        placement: { type: "direct" },
      }],
    }, { toolCallId: "create-call" });

    expect(result.structuredContent).toMatchObject({ results: [{ status: "created", threadId: "thread-1" }] });
    expect(service.threadCreateBatch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceToolCallId: "create-call" }),
      expect.objectContaining({ items: [expect.objectContaining({ title: "Delegated thread" })] }),
    );
  });

  it("returns each thread_send and thread_stop result variant", async () => {
    const { call, service } = setup();
    const sent = (value: unknown) => ThreadSendResultSchema().parse(value);
    const stopped = (value: unknown) => ThreadStopResultSchema().parse(value);
    const base = { workspaceId: "workspace-1", threadId: "destination-thread" };
    service.threadSend
      .mockResolvedValueOnce(sent({ ...base, status: "accepted", turnId: "turn-1", execution, state: { status: "starting" } }))
      .mockResolvedValueOnce(sent({ ...base, status: "pending_approval", approvalId: "approval-1", state: { status: "waiting_for_approval", approvalId: "approval-1" } }))
      .mockResolvedValueOnce(sent({ ...base, status: "rejected", error: { code: "thread_busy", message: "Thread is already running", retryable: true } }));
    service.threadStop
      .mockResolvedValueOnce(stopped({ ...base, status: "accepted", state: { status: "stopped" } }))
      .mockResolvedValueOnce(stopped({ ...base, status: "pending_approval", approvalId: "approval-2", state: { status: "waiting_for_approval", approvalId: "approval-2" } }))
      .mockResolvedValueOnce(stopped({ ...base, status: "rejected", error: { code: "internal_error", message: "Stop failed", retryable: true } }));

    const sends = [] as unknown[];
    const stops = [] as unknown[];
    for (const id of ["send-1", "send-2", "send-3"]) {
      sends.push((await call("thread_send", { threadId: "destination-thread", message: "Continue" }, { toolCallId: id })).structuredContent);
      stops.push((await call("thread_stop", { threadId: "destination-thread" }, { toolCallId: id })).structuredContent);
    }

    expect(sends).toMatchObject([{ status: "accepted" }, { status: "pending_approval" }, { status: "rejected" }]);
    expect(stops).toMatchObject([{ status: "accepted" }, { status: "pending_approval" }, { status: "rejected" }]);
  });

  it("dispatches search, get, and wait with defaults and without mutating the destination", async () => {
    const { call, service } = setup();
    service.threadSearch.mockResolvedValue(ThreadSearchResultSchema().parse({ threads: [thread] }));
    service.threadGet.mockResolvedValue(ThreadGetResultSchema().parse({
      status: "found",
      workspaceId: "workspace-1",
      thread,
      messages: [],
      hasMoreMessages: false,
    }));
    service.threadWait.mockResolvedValue(timedOutWait());

    await expect(call("thread_search", { query: "Destination" }, { toolCallId: "search-call" }))
      .resolves.toMatchObject({ structuredContent: { threads: [{ threadId: "destination-thread" }] } });
    await expect(call("thread_get", { threadId: "destination-thread" }, { toolCallId: "get-call" }))
      .resolves.toMatchObject({ structuredContent: { status: "found", thread: { threadId: "destination-thread" } } });
    await expect(call("thread_wait", { threadIds: ["destination-thread"], timeoutSeconds: 1 }, { toolCallId: "wait-call" }))
      .resolves.toMatchObject({ structuredContent: { status: "success", timedOut: true } });

    expect(service.threadSearch).toHaveBeenCalledWith(expect.objectContaining({ sourceToolCallId: "search-call" }), { query: "Destination", limit: 20 });
    expect(service.threadGet).toHaveBeenCalledWith(expect.objectContaining({ sourceToolCallId: "get-call" }), { threadId: "destination-thread", messageLimit: 50 });
    expect(service.threadWait).toHaveBeenCalledWith(
      expect.objectContaining({ sourceToolCallId: "wait-call" }),
      { threadIds: ["destination-thread"], until: "attention_or_terminal", timeoutSeconds: 1 },
      expect.any(AbortSignal),
    );
    expect(service.threadSend).not.toHaveBeenCalled();
    expect(service.threadStop).not.toHaveBeenCalled();
    expect(service.threadCreateBatch).not.toHaveBeenCalled();
  });

  it("aborts a pending thread_wait when the turn lease is revoked", async () => {
    const { authority, call, service } = setup();
    service.threadWait.mockImplementation(async (_authority, _input, signal) => {
      await waitUntilAborted(signal);
      return timedOutWait();
    });

    const pending = call("thread_wait", { threadIds: ["destination-thread"], timeoutSeconds: 10 });
    authority.revoke(session.sessionId);

    await expect(pending).resolves.toMatchObject({ structuredContent: { status: "success", timedOut: true } });
    expect(service.threadWait.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  it("aborts a pending thread_wait when the client disconnects", async () => {
    const { call, service } = setup();
    const disconnect = new AbortController();
    service.threadWait.mockImplementation(async (_authority, _input, signal) => {
      await waitUntilAborted(signal);
      return timedOutWait();
    });

    const pending = call(
      "thread_wait",
      { threadIds: ["destination-thread"], timeoutSeconds: 10 },
      { signal: disconnect.signal },
    );
    disconnect.abort();

    await expect(pending).resolves.toMatchObject({ structuredContent: { status: "success", timedOut: true } });
    expect(service.threadWait.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  it("serves each guide scoped to its own tools and rejects arguments", async () => {
    const { call } = setup();

    await expect(call("mcode_browser_guide")).resolves.toMatchObject({
      structuredContent: { guide: expect.stringContaining("browser_inspect") },
      content: [{ type: "text", text: expect.not.stringContaining("thread_create_batch") }],
    });
    await expect(call("thread_control_guide")).resolves.toMatchObject({
      structuredContent: { guide: expect.stringContaining("thread_create_batch") },
      content: [{ type: "text", text: expect.not.stringContaining("browser_status") }],
    });
    await expect(call("thread_control_guide", { extra: true })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "thread_control_guide accepts no arguments" }],
    });
  });

  it("turns a service failure into a tool error the model can read", async () => {
    const { call, service } = setup();
    service.threadGet.mockRejectedValue(new Error("Thread store unavailable"));

    await expect(call("thread_get", { threadId: "destination-thread" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Thread store unavailable" }],
    });
  });
});
