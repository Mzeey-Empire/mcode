import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventType, ProviderRuntimeEventSchema, type ProviderRuntimeEvent, type TurnRequest } from "@mcode/contracts";
import { createClaudeProvider, type ClaudeProviderBoundary, type ProviderFactoryInput, type ProviderEventDraft } from "../index.js";
import { DeterministicCanonicalSink } from "../conformance/deterministic-sink.js";
import { fixtureHost } from "../private/claude/__tests__/helpers/provider-fixture.js";
import { BrowserAutomationSessionLease } from "../private/claude/__tests__/helpers/provider-fixture.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as NodeURL from "node:url";
import { loadProviderFixtureManifest, validateProviderFixtureManifest } from "../conformance/fixture-safety.js";
import { ProviderParentEvidenceSchema } from "@mcode/contracts";
import { queryMethodStubs } from "../private/claude/__tests__/helpers/mock-sdk-query.js";

const { sdkQuery } = vi.hoisted(() => ({ sdkQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQuery }));
vi.mock("@mcode/shared", async (original) => ({ ...await original<typeof import("@mcode/shared")>(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const execution1 = "00000000-0000-4000-8000-000000000001";
const execution2 = "00000000-0000-4000-8000-000000000002";
function request(overrides: Partial<TurnRequest<"claude">> = {}): TurnRequest<"claude"> {
  return { turnId: "turn-1", turnExecutionId: execution1, deliveryAttempt: 1, sessionId: "mcode-thread-1", workspaceId: "workspace-1", threadId: "thread-1", message: "fixture", cwd: process.cwd(), model: "claude-sonnet-4-6", interactionMode: "build", permissionMode: "supervised", providerOptions: {}, ...overrides };
}

type NativeMessage = Record<string, unknown>;
function result(id = "RESULT_1"): NativeMessage { return { type: "result", uuid: id, is_error: false, usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01, num_turns: 1, duration_ms: 3 }; }
function installTransport(messages: (turn: number, options: Options) => readonly NativeMessage[] = (turn) => [result(`RESULT_${turn}`)], emitInit = true) {
  const optionsSeen: Options[] = [];
  const inputs: unknown[] = [];
  sdkQuery.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    optionsSeen.push(options);
    let turn = 0;
    const stream = (async function* () {
      for await (const input of prompt) {
        inputs.push(input);
        turn++;
        if (emitInit) yield { type: "system", subtype: "init", session_id: "NATIVE_PARENT", parent_tool_use_id: null, slash_commands: [] };
        for (const message of messages(turn, options)) yield message;
      }
    })();
    return Object.assign(stream, queryMethodStubs(), { close: vi.fn(() => { void stream.return(); }), setModel: vi.fn(async () => undefined) });
  });
  return { optionsSeen, inputs };
}

function fixture() {
  const sink = new DeterministicCanonicalSink();
  const drafts: ProviderEventDraft[] = [];
  const host = fixtureHost({ events: { submit: async (batch) => { drafts.push(...batch.events); return sink.submit(batch); } } });
  const input: ProviderFactoryInput = { configuration: { cliPath: process.execPath, idleSessionTtlMs: 60_000 }, host, claude: { createForker: (generator) => ({ fork: async (req) => { await generator.runSideChannelQuery({ parentThreadId: req.parentThreadId, parentSdkSessionId: req.parentSdkSessionId ?? "", prompt: req.prompt, cwd: req.cwd }); throw new Error("Fixture handoff artifacts are server-owned"); } }) } };
  const provider = createClaudeProvider(input);
  providers.push(provider);
  const events = (): ProviderRuntimeEvent[] => drafts.flatMap((draft) => draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent" ? [ProviderRuntimeEventSchema().parse(JSON.parse(JSON.stringify(draft.payload.item.payload.runtimeEvent)))] : []);
  return { provider, input, drafts, events, sink };
}
const providers: ClaudeProviderBoundary[] = [];
beforeEach(() => { sdkQuery.mockReset(); });
afterEach(async () => { await Promise.allSettled(providers.splice(0).map((provider) => provider.shutdown())); });
async function completed(events: () => ProviderRuntimeEvent[], count: number) { await vi.waitFor(() => expect(events().filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(count)); }

describe("Claude public factory core and capabilities", () => {
  it("carries native ExitPlanMode capture into the canonical assistant message once", async () => {
    const decisions: Array<Promise<unknown>> = [];
    installTransport((turn, options) => {
      if (turn === 1) {
        assert(options.canUseTool);
        decisions.push(options.canUseTool("ExitPlanMode", { plan: "# Native plan\n## Build\nShip it." },
          { signal: new AbortController().signal, toolUseID: "PLAN_NATIVE" }));
      }
      return [{ type: "assistant", uuid: `ASSISTANT_${turn}`, parent_tool_use_id: null,
        message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Summary." }] } }, result(`RESULT_${turn}`)];
    });
    const { provider, events } = fixture();
    const capture = vi.fn();
    provider.on("plan_captured", capture);
    provider.setPlanAnswerMode("thread-1", true);
    await provider.sendTurn(request());
    await completed(events, 1);
    expect(await Promise.all(decisions)).toEqual([{ behavior: "deny",
      message: "The client captured your proposed plan. Stop here and wait for the user to review it." }]);
    expect(capture).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1", markdown: "# Native plan\n## Build\nShip it.", source: "native",
    });
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(events().filter((runtime) => runtime.planCapture).map((runtime) => ({
      type: runtime.event.type, executionId: runtime.event.turnExecutionId, capture: runtime.planCapture,
    }))).toEqual([{ type: "message", executionId: execution1,
      capture: { markdown: "# Native plan\n## Build\nShip it.", source: "native" } }]);
  });
  it("validates configuration and host ports without SDK or host I/O", () => {
    installTransport();
    const { provider, input } = fixture();
    expect(sdkQuery).not.toHaveBeenCalled();
    expect(provider.id).toBe("claude");
    expect(() => createClaudeProvider({ ...input, claude: undefined })).toThrow("createForker");
    expect(() => createClaudeProvider({ ...input, configuration: { ...input.configuration, idleSessionTtlMs: 0 } })).toThrow("idleSessionTtlMs");
    Reflect.deleteProperty(input.host.events, "submit");
    expect(() => createClaudeProvider(input)).toThrow("events.submit");
  });

  it("reuses the live queue for first and follow-up turns with exact execution routing and usage", async () => {
    const transport = installTransport();
    const { provider, events, drafts } = fixture();
    const direct = vi.fn();
    provider.on("event", direct);
    await provider.sendTurn(request());
    await completed(events, 1);
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(transport.inputs).toHaveLength(2);
    expect(drafts.filter((draft) => draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent" && draft.payload.item.payload.runtimeEvent.event.type === AgentEventType.TurnComplete).map((draft) => draft.routing.executionId)).toEqual([execution1, execution2]);
    expect(events().find(({ event }) => event.type === AgentEventType.TurnComplete)?.event).toMatchObject({ costUsd: 0.01, tokensIn: 1, tokensOut: 2 });
    expect(transport.optionsSeen[0]?.pathToClaudeCodeExecutable).toBe(process.execPath);
    expect(direct).not.toHaveBeenCalled();
    await provider.stopSession("mcode-thread-1");
    await provider.stopSession("mcode-thread-1");
  });

  it("recreates spawn-fixed permissions and resume settings while preserving native parent identity", async () => {
    const transport = installTransport();
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await completed(events, 1);
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2, permissionMode: "full", resumeFrom: "NATIVE_PARENT", providerOptions: { contextWindowMode: "1m" } }));
    await completed(events, 2);
    expect(sdkQuery).toHaveBeenCalledTimes(2);
    expect(transport.optionsSeen[1]).toMatchObject({ resume: "NATIVE_PARENT", permissionMode: "bypassPermissions" });
  });

  it("forks a side channel with forkSession without changing the parent's live query or native identity", async () => {
    const transport = installTransport((turn, options) => options.forkSession ? [{ type: "assistant", message: { content: [{ type: "text", text: "fixture handoff" }] } }, result()] : [result(`RESULT_${turn}`)]);
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await completed(events, 1);
    await provider.runSideChannelQuery({ parentThreadId: "thread-1", parentSdkSessionId: "NATIVE_PARENT", prompt: "fixture", cwd: process.cwd() });
    expect(transport.optionsSeen[1]).toMatchObject({ resume: "NATIVE_PARENT", forkSession: true, persistSession: false, tools: [] });
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(sdkQuery).toHaveBeenCalledTimes(2);
    expect(events().filter(({ event }) => event.type === AgentEventType.System && event.subtype?.startsWith("sdk_session_id:"))).toHaveLength(1);
  });

  it("provides completion through an ephemeral query and isolates its output from live canonical events", async () => {
    installTransport(() => [{ type: "result", is_error: false, result: "fixture completion" }]);
    const { provider, events } = fixture();
    expect(provider.complete).toBeTypeOf("function");
    expect(await provider.complete?.("fixture", "claude-sonnet-4-6", process.cwd())).toBe("fixture completion");
    expect(events()).toEqual([]);
  });

  it("consumes scoped grants and resolves a supervised permission through the public boundary", async () => {
    const transport = installTransport();
    const { provider, input, events } = fixture();
    input.host.grants.consume = vi.fn(() => true);
    await provider.sendTurn(request());
    await completed(events, 1);
    const canUseTool = transport.optionsSeen[0]?.canUseTool;
    expect(canUseTool).toBeTypeOf("function");
    const granted = await canUseTool?.("Read", { path: "fixture.md" }, { signal: new AbortController().signal, toolUseID: "READ_1" });
    expect(granted?.behavior).toBe("allow");
    input.host.grants.consume = () => false;
    const permission = new Promise<string>((resolve) => { provider.on("permission_request", (req) => { expect(provider.resolvePermission?.(req.requestId, "allow")).toBe(true); resolve(req.requestId); }); });
    const pending = canUseTool?.("Read", { path: "other.md" }, { signal: new AbortController().signal, toolUseID: "READ_2" });
    await permission;
    expect((await pending)?.behavior).toBe("allow");
  });

  it("preserves exact parallel and nested parent evidence through validated canonical draft serialization", async () => {
    installTransport(() => [
      { type: "tool_use", uuid: "START_A", id: "CHILD_A", name: "Agent", parent_tool_use_id: "PARENT_A" },
      { type: "tool_use", uuid: "START_B", id: "CHILD_B", name: "Agent", parent_tool_use_id: "PARENT_B" },
      { type: "tool_progress", uuid: "PROGRESS_A", tool_use_id: "CHILD_A", tool_name: "Agent" },
      { type: "tool_use", uuid: "NESTED", id: "NESTED_C", name: "Read", parent_tool_use_id: "CHILD_A" },
      { type: "stream_event", uuid: "DELTA_B", parent_tool_use_id: "PARENT_B", event: { type: "content_block_delta", delta: { type: "text_delta", text: "fixture" } } },
      { type: "user", uuid: "RESULT_A", message: { content: [{ type: "tool_result", tool_use_id: "CHILD_A" }] } },
      { type: "tool_progress", uuid: "ROOT", tool_use_id: "ROOT_TOOL", parent_tool_use_id: null },
      { type: "tool_progress", uuid: "ABSENT", tool_use_id: "UNKNOWN_TOOL" },
      result(),
    ]);
    const { provider, events, drafts } = fixture();
    const failures: Error[] = [];
    provider.setCanonicalTurnDeliveryFailureHandler((_routing, error) => { failures.push(error); });
    await provider.sendTurn(request());
    try { await completed(events, 1); } catch (error) { throw failures[0] ?? new Error(JSON.stringify(events()), { cause: error }); }
    expect(events().filter(({ event }) => event.type === AgentEventType.ToolUse).map(({ event, parentEvidence }) => [event.toolCallId, parentEvidence])).toEqual([
      ["CHILD_A", { kind: "native", identity: { providerId: "claude", scope: "parentItem", value: "PARENT_A", provenance: "native" } }],
      ["CHILD_B", { kind: "native", identity: { providerId: "claude", scope: "parentItem", value: "PARENT_B", provenance: "native" } }],
      ["NESTED_C", { kind: "native", identity: { providerId: "claude", scope: "parentItem", value: "CHILD_A", provenance: "native" } }],
    ]);
    expect(events().find(({ event }) => event.type === AgentEventType.ToolResult)?.parentEvidence).toMatchObject({ kind: "native", identity: { value: "PARENT_A" } });
    expect(events().find(({ event }) => event.type === AgentEventType.TextDelta)?.parentEvidence).toMatchObject({ kind: "native", identity: { value: "PARENT_B" } });
    expect(events().find(({ event }) => "toolCallId" in event && event.toolCallId === "ROOT_TOOL")?.parentEvidence).toEqual({ kind: "root" });
    expect(events().find(({ event }) => "toolCallId" in event && event.toolCallId === "UNKNOWN_TOOL")?.parentEvidence).toEqual({ kind: "absent" });
    expect(drafts.some((draft) => draft.sourceIdentities.some((identity) => identity.scope === "item" && identity.value === "CHILD_A"))).toBe(true);
  });

  it("reports a rejected sink promptly for the exact execution and delivery attempt", async () => {
    installTransport(() => [{ type: "tool_progress", tool_use_id: "TOOL_1" }]);
    const { provider, input } = fixture();
    input.host.events.submit = async () => { throw new Error("sink rejected"); };
    const failed = vi.fn();
    provider.setCanonicalTurnDeliveryFailureHandler(failed);
    await provider.sendTurn(request({ deliveryAttempt: 3 }));
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1", executionId: execution1, deliveryAttempt: 3 }, expect.objectContaining({ message: "sink rejected" })));
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(provider.shutdown()).rejects.toThrow("shutdown failed");
  });

  it("publishes metadata and notification projections from one native envelope without a replay conflict", async () => {
    const message = { type: "system", subtype: "notification", session_id: "SESSION_1", uuid: "EVENT_1", parent_tool_use_id: null };
    installTransport(() => [message, message, result()], false);
    const { provider, events } = fixture();
    const failure = vi.fn();
    provider.setCanonicalTurnDeliveryFailureHandler(failure);

    await provider.sendTurn(request());
    await completed(events, 1);

    expect(events().filter(({ event }) => event.type === AgentEventType.System).map(({ event, parentEvidence }) => [event.subtype, parentEvidence])).toEqual([
      ["sdk_session_id:SESSION_1", { kind: "root" }],
      ["notification", { kind: "root" }],
    ]);
    expect(failure).not.toHaveBeenCalled();
    await provider.shutdown();
  });

  it("declares only implemented profiles and explicitly excludes native continuation and independent child cancellation", () => {
    const { provider } = fixture();
    expect(provider.descriptor.capabilities.filter(({ support }) => support === "supported").map(({ name }) => name)).toEqual(["build", "plan", "completion", "goals", "permissions", "usage", "session-eviction", "clean-fork", "orchestration", "browser-access", "thread-control"]);
    expect(provider.descriptor.capabilities).toContainEqual({ name: "provider-continuation", support: "unsupported" });
    expect(provider.descriptor.capabilities).toContainEqual({ name: "child-cancellation", support: "unsupported" });
  });

  it("composes plan controls, goals, orchestration, browser leases and validated SDK-local thread control", async () => {
    const transport = installTransport();
    const { provider, input, events } = fixture();
    const browser = new BrowserAutomationSessionLease();
    browser.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "fixture" });
    input.host.browser = browser;
    const mcpServer = new McpServer({ name: "fixture", version: "0" });
    input.host.threadControl.bootstrap = vi.fn(async () => mcpServer);
    input.host.threadControl.close = vi.fn(async () => undefined);
    provider.setPlanAnswerMode("thread-1", true);
    await provider.setGoal("mcode-thread-1", "fixture objective");
    await provider.sendTurn(request({ interactionMode: "plan", orchestrationMode: "proactive" }));
    await completed(events, 1);
    const options = transport.optionsSeen[0];
    assert(options);
    expect(options.mcpServers?.mcode_internal_thread_control).toMatchObject({ type: "sdk", instance: mcpServer });
    expect(options.mcpServers?.["mcode-browser"]).toMatchObject({ type: "http", url: "http://127.0.0.1:19400/mcp" });
    expect(options.settings).toMatchObject({ ultracode: true });
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining("browser_inspect") });
    expect(await provider.getGoal("mcode-thread-1")).toMatchObject({ objective: "fixture objective" });
    assert(options.hooks);
    assert(options.hooks.Stop);
    const stop = options.hooks.Stop[0];
    assert(stop);
    const stopHook = stop.hooks[0];
    assert(stopHook);
    expect(await stopHook({ hook_event_name: "Stop", stop_hook_active: false, session_id: "NATIVE_PARENT", transcript_path: "fixture", cwd: process.cwd() }, undefined, { signal: new AbortController().signal })).toMatchObject({ decision: "block" });
    const canUseTool = options.canUseTool;
    assert(canUseTool);
    const plan = vi.fn();
    provider.on("plan_captured", plan);
    await canUseTool("ExitPlanMode", { plan: "fixture plan" }, { signal: new AbortController().signal, toolUseID: "PLAN_1" });
    expect(plan).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-1", markdown: "fixture plan", source: "native" });
    provider.setPlanAnswerMode("thread-1", false);
    expect(await provider.clearGoal("mcode-thread-1")).toBe(true);
    await provider.discardSession("mcode-thread-1");
    expect(browser.status()).toEqual({ active: 0, pending: 0 });
    expect(input.host.threadControl.close).toHaveBeenCalledWith("mcode-thread-1");
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(sdkQuery).toHaveBeenCalledTimes(2);
  });

  it("routes pooled PostCompact hooks to the consumed follow-up execution", async () => {
    const transport = installTransport();
    const { provider, events, drafts } = fixture();
    await provider.sendTurn(request());
    await completed(events, 1);
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    await transport.optionsSeen[0]?.hooks?.PostCompact?.[0]?.hooks[0]?.({ hook_event_name: "PostCompact", compact_summary: "fixture summary", session_id: "NATIVE_PARENT", transcript_path: "fixture", cwd: process.cwd(), trigger: "auto" }, undefined, { signal: new AbortController().signal });
    await vi.waitFor(() => expect(events().filter(({ event }) => event.type === AgentEventType.CompactSummary)).toHaveLength(1));
    expect(drafts.find((draft) => draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent" && draft.payload.item.payload.runtimeEvent.event.type === AgentEventType.CompactSummary)?.routing.executionId).toBe(execution2);
  });

  it("stops a turn awaiting bootstrap without starting a query, then accepts a following turn", async () => {
    installTransport();
    const { provider, input, events } = fixture();
    let release!: () => void;
    const bootstrap = new Promise<void>((resolve) => { release = resolve; });
    const bootstrapped = vi.fn(async () => { await bootstrap; return null; });
    input.host.threadControl.bootstrap = bootstrapped;
    const sending = provider.sendTurn(request());
    await vi.waitFor(() => expect(bootstrapped).toHaveBeenCalledOnce());
    await provider.stopSession("mcode-thread-1");
    release();
    await sending;
    expect(sdkQuery).not.toHaveBeenCalled();
    await provider.stopSession("mcode-thread-1");
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 1);
    await Promise.all([provider.shutdown(), provider.shutdown()]);
    await expect(provider.sendTurn(request())).rejects.toThrow("shutting down");
  });

  it("replays the safe synthetic native assistant/user envelopes through the real factory", async () => {
    const manifest = loadProviderFixtureManifest(NodeURL.fileURLToPath(new URL("../conformance/fixtures/claude-native.synthetic.json", import.meta.url)));
    const trace = manifest.input.claudeNativeTrace;
    if (!trace) throw new Error("Claude native fixture is missing");
    installTransport(() => trace.nativeMessages);
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await completed(events, trace.expected.terminalCount);
    expect(manifest.provenance).toBe("synthetic");
    expect(events().filter(({ event }) => event.type === AgentEventType.ToolUse).map(({ event, parentEvidence }) => [event.toolCallId, parentEvidence?.kind === "native" ? parentEvidence.identity.value : null])).toEqual(trace.expected.toolStarts);
    expect(events().filter(({ event }) => event.type === AgentEventType.ToolResult).map(({ event }) => event.toolCallId)).toEqual(trace.expected.toolResults);
    const unsafe = JSON.parse(JSON.stringify(manifest));
    unsafe.input.claudeNativeTrace.nativeMessages[0].message.content[0].input = { path: "fixture" };
    expect(() => validateProviderFixtureManifest(unsafe)).toThrow();
  });

  it("replays captured SDK failure through error delivery and stream teardown", async () => {
    const manifest = loadProviderFixtureManifest(NodeURL.fileURLToPath(new URL("../conformance/fixtures/claude-startup-error.captured.json", import.meta.url)));
    const trace = manifest.input.claudeNativeTrace;
    assert(trace);
    expect(manifest.provenance).toBe("captured");
    expect(manifest.requiredProfiles).toEqual(["core"]);
    expect(manifest.expected.terminal).toBe("errored");
    expect(trace.sdkFailure).toEqual({ kind: "authentication" });
    sdkQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const stream = (async function* () {
        for await (const _input of prompt) {
          yield* trace.nativeMessages;
          throw new Error("Not logged in");
        }
      })();
      return Object.assign(stream, queryMethodStubs(), { close: vi.fn(() => { void stream.return(); }) });
    });
    const { provider, events, drafts } = fixture();
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(events().filter(({ event }) => event.type === AgentEventType.Ended)).toHaveLength(trace.expected.terminalCount));
    expect(events().filter(({ event }) => event.type === AgentEventType.Error || event.type === AgentEventType.Ended || event.type === AgentEventType.TurnComplete).map(({ event }) => event.type)).toEqual([AgentEventType.Error, AgentEventType.Ended]);
    expect(events().filter(({ event }) => event.type === AgentEventType.ToolUse)).toEqual(trace.expected.toolStarts);
    expect(events().filter(({ event }) => event.type === AgentEventType.ToolResult)).toEqual(trace.expected.toolResults);
    const errorDraft = drafts.find((draft) => draft.payload.type === "item.recorded" && draft.payload.item.payload.projection === "providerRuntimeEvent" && draft.payload.item.payload.runtimeEvent.event.type === AgentEventType.Error);
    expect(errorDraft?.sourceIdentities).toEqual([
      { providerId: "claude", scope: "session", value: "NATIVE_2", provenance: "native" },
    ]);
    const unsafe = JSON.parse(JSON.stringify(manifest));
    unsafe.input.claudeNativeTrace.nativeMessages[1].message.content = [{ type: "text", text: "private response" }];
    expect(() => validateProviderFixtureManifest(unsafe)).toThrow();
  });

  it("validates absent, root and native parent evidence without accepting derived or non-parent identities", () => {
    const schema = ProviderParentEvidenceSchema();
    expect(schema.parse({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(schema.parse({ kind: "root" })).toEqual({ kind: "root" });
    expect(schema.safeParse({ kind: "native", identity: { providerId: "claude", scope: "item", value: "PARENT_1", provenance: "native" } }).success).toBe(false);
    expect(schema.safeParse({ kind: "native", identity: { providerId: "claude", scope: "parentItem", value: "PARENT_1", provenance: "derived" } }).success).toBe(false);
  });
});
