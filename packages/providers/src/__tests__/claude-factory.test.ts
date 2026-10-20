import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventType, ProviderRuntimeEventSchema, type ProviderRuntimeEvent, type TurnRequest } from "@mcode/contracts";
import { createClaudeProvider, type ClaudeProviderBoundary, type ProviderFactoryInput, type ProviderEventDraft, type ProviderMcodeAttachment } from "../index.js";
import { DeterministicCanonicalSink } from "../conformance/deterministic-sink.js";
import { fixtureHost } from "../private/claude/__tests__/helpers/provider-fixture.js";
import { BrowserAutomationSessionLease } from "../private/claude/__tests__/helpers/provider-fixture.js";
import * as NodeURL from "node:url";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { PLAN_MAX_CONTENT_CHARS, type PlanCapture } from "@mcode/contracts";
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

function mcodeAttachment(toolkits = { browser: true, threadControl: true }): ProviderMcodeAttachment {
  return { serverName: "mcode", url: "http://127.0.0.1:19400/mcp/mcode", token: "fixture-token", toolkits };
}

type NativeMessage = Record<string, unknown>;
function result(id = "RESULT_1"): NativeMessage { return { type: "result", uuid: id, is_error: false, usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01, num_turns: 1, duration_ms: 3 }; }
function installTransport(messages: (turn: number, options: Options) => readonly NativeMessage[] | Promise<readonly NativeMessage[]> = (turn) => [result(`RESULT_${turn}`)], emitInit = true) {
  const optionsSeen: Options[] = [];
  const inputs: unknown[] = [];
  const consumedModes: Options["permissionMode"][] = [];
  let rejectModeChange = false;
  sdkQuery.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    optionsSeen.push(options);
    let mode = options.permissionMode;
    let turn = 0;
    const stream = (async function* () {
      for await (const input of prompt) {
        inputs.push(input);
        consumedModes.push(mode);
        turn++;
        if (emitInit) yield { type: "system", subtype: "init", session_id: "NATIVE_PARENT", parent_tool_use_id: null, slash_commands: [] };
        for (const message of await messages(turn, options)) yield message;
      }
    })();
    return Object.assign(stream, queryMethodStubs(), {
      close: vi.fn(() => { void stream.return(); }), setModel: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async (next: NonNullable<Options["permissionMode"]>) => {
        if (rejectModeChange) {
          rejectModeChange = false;
          throw new Error("Permission switch refused");
        }
        if (next === "bypassPermissions" && !options.allowDangerouslySkipPermissions) throw new Error("Bypass not enabled at spawn");
        mode = next;
      }),
    });
  });
  return { optionsSeen, inputs, consumedModes, rejectPermissionSwitch: () => { rejectModeChange = true; } };
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
const planDirectories: string[] = [];
beforeEach(() => { sdkQuery.mockReset(); });
afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.shutdown()));
  for (const directory of planDirectories.splice(0)) await NodeFSPromises.rm(directory, { recursive: true, force: true });
});
async function completed(events: () => ProviderRuntimeEvent[], count: number) { await vi.waitFor(() => expect(events().filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(count)); }

async function createNativePlanFixture(proof: string) {
  const scratch = NodePath.resolve(import.meta.dirname, "../../../../.dev/claude-plan-tests");
  await NodeFSPromises.mkdir(scratch, { recursive: true });
  const cwd = await NodeFSPromises.mkdtemp(NodePath.join(scratch, "case-"));
  planDirectories.push(cwd);
  const configDir = NodePath.join(cwd, "config");
  const parent = proof === "config-root" ? NodePath.join(configDir, "plans") : NodePath.join(cwd, ".claude", "plans");
  let fileDirectory = parent;
  if (proof === "outside") fileDirectory = cwd;
  if (proof === "sibling-prefix") fileDirectory = `${parent}-other`;
  await NodeFSPromises.mkdir(fileDirectory, { recursive: true });
  const filePath = NodePath.join(fileDirectory, "plan.md");
  const path = proof === "relative" ? NodePath.relative(cwd, filePath) : filePath;
  if (proof !== "missing") await NodeFSPromises.writeFile(filePath, proof === "oversized" ? "x".repeat(PLAN_MAX_CONTENT_CHARS + 1) : "abc");
  return { cwd, configDir, parent, path };
}

describe("Claude native plan turns", () => {
  it.each(["full", "supervised"] as const)("switches all plan kinds and build on one %s session", async permissionMode => {
    const transport = installTransport();
    const { provider, events } = fixture();
    await provider.sendTurn(request({ permissionMode, planTurn: { kind: "questions", planFilePath: null } }));
    await completed(events, 1);
    for (const [index, kind] of (["planning", "revise", undefined] as const).entries()) {
      await provider.sendTurn(request({ permissionMode, turnId: `turn-${index + 2}`,
        turnExecutionId: `00000000-0000-4000-8000-00000000000${index + 2}`,
        planTurn: kind ? { kind, planFilePath: null } : undefined }));
      await completed(events, index + 2);
    }
    expect(transport.optionsSeen).toHaveLength(1);
    expect(transport.optionsSeen[0]).toMatchObject({ permissionMode: "plan", ...(permissionMode === "full" && { allowDangerouslySkipPermissions: true }) });
    expect(transport.optionsSeen[0]?.allowDangerouslySkipPermissions).toBe(permissionMode === "full" ? true : undefined);
    expect(transport.consumedModes).toEqual(["plan", "plan", "plan", permissionMode === "full" ? "bypassPermissions" : "default"]);
    await provider.sendTurn(request({ permissionMode, turnId: "turn-5", turnExecutionId: "00000000-0000-4000-8000-000000000005",
      planTurn: { kind: "planning", planFilePath: null } }));
    await completed(events, 5);
    expect(transport.consumedModes[4]).toBe("plan");
    expect(transport.optionsSeen).toHaveLength(1);
  });

  it.each([false, true])("recovers a failed permission switch with a fresh session (starts in plan: %s)", async startsInPlan => {
    const transport = installTransport(async (_turn, options) => {
      assert(options.canUseTool);
      await options.canUseTool("ExitPlanMode", { plan: "# Plan" }, { signal: new AbortController().signal, toolUseID: "EXIT" });
      return [result()];
    });
    const { provider, events } = fixture();
    const captures: PlanCapture[] = [];
    provider.on("plan_captured", capture => captures.push(capture));
    const planTurn = { kind: "planning", planFilePath: null } as const;
    await provider.sendTurn(request({ permissionMode: "full", planTurn: startsInPlan ? planTurn : undefined }));
    await completed(events, 1);
    transport.rejectPermissionSwitch();
    await provider.sendTurn(request({ permissionMode: "full", turnId: "turn-2", turnExecutionId: execution2,
      planTurn: startsInPlan ? undefined : planTurn }));
    await completed(events, 2);
    expect(transport.optionsSeen.map(options => options.permissionMode)).toEqual(startsInPlan
      ? ["plan", "bypassPermissions"] : ["bypassPermissions", "plan"]);
    await provider.sendTurn(request({ permissionMode: "full", turnId: "turn-3",
      turnExecutionId: "00000000-0000-4000-8000-000000000003", planTurn: startsInPlan ? planTurn : undefined }));
    await completed(events, 3);
    expect(transport.optionsSeen).toHaveLength(2);
    expect(transport.consumedModes).toEqual(startsInPlan
      ? ["plan", "bypassPermissions", "plan"] : ["bypassPermissions", "plan", "bypassPermissions"]);
    expect(captures).toEqual(Array.from({ length: startsInPlan ? 2 : 1 }, () => ({ threadId: "thread-1", markdown: "# Plan", source: "native" })));
    expect(events().filter(({ event }) => event.type === AgentEventType.Error)).toEqual([]);
  });

  it.each(["planning", "revise", "questions"] as const)("blocks mutations without approval in full-access %s turns, then permits normal build approval", async kind => {
    const replies: unknown[] = [];
    const edit = { file_path: NodePath.join(process.cwd(), "source.ts"), old_string: "old", new_string: "new" };
    const mutations = [
      { toolName: "Edit", input: edit },
      { toolName: "Write", input: { file_path: edit.file_path, content: "new" } },
      { toolName: "MultiEdit", input: { file_path: edit.file_path, edits: [{ old_string: "old", new_string: "new" }] } },
      { toolName: "NotebookEdit", input: { notebook_path: edit.file_path, new_source: "new", cell_type: "code" } },
      { toolName: "Bash", input: { command: "touch source.ts" } },
      { toolName: "PowerShell", input: { command: "Set-Content source.ts new" } },
      { toolName: "Monitor", input: { command: "git checkout -- ." } },
      { toolName: "EnterWorktree", input: { name: "scratch" } },
    ];
    const transport = installTransport(async (turn, options) => {
      assert(options.canUseTool);
      for (const { toolName, input } of turn === 1 ? mutations : [{ toolName: "Edit", input: edit }]) {
        replies.push(await options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: toolName }));
      }
      return [result(`RESULT_${turn}`)];
    });
    const { provider, events } = fixture();
    const approval = vi.fn();
    provider.on("approval_request", req => {
      approval(req);
      void provider.resolveApproval?.(req.requestId, { choiceId: "allow" });
    });
    await provider.sendTurn(request({ permissionMode: "full", planTurn: { kind, planFilePath: null } }));
    await completed(events, 1);
    expect(replies).toEqual(Array.from({ length: mutations.length }, () => ({ behavior: "deny", message: "Plan mode is read-only. Describe the change in the plan instead." })));
    expect(approval).not.toHaveBeenCalled();
    await provider.sendTurn(request({ permissionMode: "full", turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(replies[mutations.length]).toEqual({ behavior: "allow", updatedInput: edit });
    expect(transport.optionsSeen).toHaveLength(1);
  });

  it("denies plan-turn mutations in the PreToolUse hook, which runs before allow rules, but leaves Claude's plan file and build turns alone", async () => {
    const { cwd, path } = await createNativePlanFixture("proved");
    const source = NodePath.join(cwd, "source.ts");
    const decisions: Record<string, unknown>[] = [];
    installTransport(async (_turn, options) => {
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      assert(hook);
      for (const [tool_name, tool_input] of [["Edit", { file_path: source }], ["Bash", { command: "git checkout -- ." }],
        ["Edit", { file_path: path }], ["Read", { file_path: source }]] as const) {
        decisions.push(await hook({ hook_event_name: "PreToolUse", session_id: "NATIVE_PARENT", cwd, transcript_path: "fixture",
          tool_use_id: tool_name, tool_name, tool_input }, tool_name, { signal: new AbortController().signal }));
      }
      return [result()];
    });
    const { provider, events } = fixture();
    await provider.sendTurn(request({ cwd, permissionMode: "full", planTurn: { kind: "revise", planFilePath: null } }));
    await completed(events, 1);
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "Plan mode is read-only. Describe the change in the plan instead." } };
    expect(decisions).toEqual([deny, deny, {}, {}]);
    decisions.length = 0;
    await provider.sendTurn(request({ cwd, permissionMode: "full", turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(decisions).toEqual([{}, {}, {}, {}]);
  });

  it("keeps the plan-file exemption inside the plan root: no links out, no non-markdown files", async () => {
    const { cwd, parent, path } = await createNativePlanFixture("proved");
    const outside = NodePath.join(cwd, "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.symlink(outside, NodePath.join(parent, "linked"), "junction");
    const decisions: Record<string, unknown>[] = [];
    installTransport(async (_turn, options) => {
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      assert(hook);
      for (const file_path of [path, NodePath.join(parent, "new-plan.md"), NodePath.join(parent, "run.sh"),
        NodePath.join(parent, "linked", "escape.md")]) {
        decisions.push(await hook({ hook_event_name: "PreToolUse", session_id: "NATIVE_PARENT", cwd, transcript_path: "fixture",
          tool_use_id: "EDIT", tool_name: "Write", tool_input: { file_path } }, "EDIT", { signal: new AbortController().signal }));
      }
      return [result()];
    });
    const { provider, events } = fixture();
    await provider.sendTurn(request({ cwd, permissionMode: "full", planTurn: { kind: "revise", planFilePath: null } }));
    await completed(events, 1);
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "Plan mode is read-only. Describe the change in the plan instead." } };
    expect(decisions).toEqual([{}, {}, deny, deny]);
  });

  it.each(["Edit", "MultiEdit"])("proves ownership of the plan file from a Revise turn's %s, which a new session after idle eviction relies on", async tool_name => {
    const { cwd, parent, path } = await createNativePlanFixture("proved");
    installTransport(async (_turn, options) => {
      assert(options.canUseTool);
      expect(options.hooks?.PostToolUse?.[0]?.matcher?.split("|")).toContain(tool_name);
      const hook = options.hooks?.PostToolUse?.[0]?.hooks[0];
      assert(hook);
      await hook({ hook_event_name: "PostToolUse", session_id: "NATIVE_PARENT", cwd, transcript_path: "fixture", tool_use_id: "EDIT",
        tool_name, tool_response: {}, tool_input: { file_path: path, old_string: "abc", new_string: "abd" } }, "EDIT", { signal: new AbortController().signal });
      await options.canUseTool("ExitPlanMode", { plan: "# Revised", planFilePath: path }, { signal: new AbortController().signal, toolUseID: "EXIT" });
      return [result()];
    });
    const { provider, events } = fixture();
    const captures: PlanCapture[] = [];
    provider.on("plan_captured", capture => captures.push(capture));
    await provider.sendTurn(request({ cwd, planTurn: { kind: "revise", planFilePath: path } }));
    await completed(events, 1);
    expect(captures[0]?.nativePlanFile).toMatchObject({ path, sessionId: "NATIVE_PARENT", root: parent });
  });

  it.each([
    ["Write", "plan file"], ["Read", "plan file"], ["mcp__mcode__thread_control", "MCP tool"],
  ])("lets a plan turn approve %s like any turn, keeping rule suggestions but never a mode switch (%s)", async (toolName) => {
    const { cwd, path } = await createNativePlanFixture("proved");
    const input = toolName.startsWith("mcp__") ? { action: "list" } : { file_path: path, content: "# Plan" };
    const rule = { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" } as const;
    const replies: unknown[] = [];
    installTransport(async (_turn, options) => {
      assert(options.canUseTool);
      replies.push(await options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: "TOOL",
        suggestions: [rule, { type: "setMode", mode: "acceptEdits", destination: "session" }] }));
      return [result()];
    });
    const { provider, events } = fixture();
    const choices: string[][] = [];
    provider.on("approval_request", req => {
      const ids = req.body.choices.map(choice => choice.id);
      choices.push(ids);
      void provider.resolveApproval?.(req.requestId, { choiceId: ids.includes("allow-session") ? "allow-session" : "allow" });
    });
    await provider.sendTurn(request({ cwd, permissionMode: "full", planTurn: { kind: "planning", planFilePath: null } }));
    await completed(events, 1);
    expect(replies).toEqual([{ behavior: "allow", updatedInput: input, updatedPermissions: [rule] }]);
    expect(choices).toEqual([["allow", "allow-session", "deny"]]);
  });

  it.each(["planning", "revise", "questions", undefined] as const)("captures ExitPlanMode only for planning/revise: %s", async kind => {
    const replies: unknown[] = [];
    installTransport(async (_turn, options) => {
      assert(options.canUseTool);
      for (const toolUseID of ["plan-1", "plan-2"]) replies.push(await options.canUseTool("ExitPlanMode", { plan: "# Plan" },
        { signal: new AbortController().signal, toolUseID }));
      return [result()];
    });
    const { provider, events } = fixture();
    const captures: PlanCapture[] = [];
    provider.on("plan_captured", capture => captures.push(capture));
    await provider.sendTurn(request({ planTurn: kind ? { kind, planFilePath: null } : undefined }));
    await completed(events, 1);
    const capturing = kind === "planning" || kind === "revise";
    expect(captures).toEqual(capturing ? [{ threadId: "thread-1", markdown: "# Plan", source: "native" }] : []);
    expect(replies).toEqual([0, 1].map(() => ({ behavior: "deny", message: capturing
      ? "The client captured your proposed plan. Reply with a one or two sentence summary of it, then stop and wait for the user to review it."
      : kind === "questions"
        ? "This Plan turn only collects questions. Reply with the questions in text; do not call ExitPlanMode."
        : "Plan mode is not active. Continue with the user's request normally." })));
  });

  it.each(["proved", "config-root", "no-write", "other-session", "other-path", "missing", "oversized", "outside", "sibling-prefix", "relative"])("requires exact Write-session file proof: %s", async proof => {
    const { cwd, configDir, parent, path } = await createNativePlanFixture(proof);
    installTransport(async (_turn, options) => {
      assert(options.canUseTool);
      if (proof !== "no-write") {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks[0];
        assert(hook);
        await hook({ hook_event_name: "PostToolUse", session_id: proof === "other-session" ? "OTHER" : "NATIVE_PARENT",
          cwd, transcript_path: "fixture", tool_use_id: "WRITE", tool_name: "Write", tool_response: {},
          tool_input: { file_path: proof === "other-path" ? NodePath.join(parent, "other.md") : path, content: "abc" } },
        "WRITE", { signal: new AbortController().signal });
      }
      await options.canUseTool("ExitPlanMode", { plan: "# Native plan", planFilePath: path },
        { signal: new AbortController().signal, toolUseID: "EXIT" });
      return [{ type: "assistant", uuid: "PLAN_MESSAGE", parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "Review this plan." }] } }, result()];
    });
    const { provider, input, events } = fixture();
    input.host.environment.snapshot = () => ({ CLAUDE_CONFIG_DIR: configDir });
    const captures: PlanCapture[] = [];
    provider.on("plan_captured", capture => captures.push(capture));
    await provider.sendTurn(request({ cwd, planTurn: { kind: "planning", planFilePath: null } }));
    await completed(events, 1);
    const proved = proof === "proved" || proof === "config-root";
    const nativePlanFile = { path, sessionId: "NATIVE_PARENT", root: parent, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    const expected = { markdown: "# Native plan", source: "native", ...(proved && { nativePlanFile }) };
    expect(captures).toEqual([{ threadId: "thread-1", ...expected }]);
    expect(events().flatMap(runtime => runtime.planCapture ? [runtime.planCapture] : [])).toEqual([expected]);
    const { provider: restarted } = fixture();
    assert(restarted.prepareImplement);
    const captured = captures[0];
    assert(captured);
    expect(await restarted.prepareImplement({ threadId: "thread-1", markdown: "# Edited", nativePlanFile: captured.nativePlanFile ?? null }))
      .toEqual(proved ? { outcome: "synced" } : { outcome: "skipped", reason: "unproven" });
    if (proved) expect(await NodeFSPromises.readFile(path, "utf8")).toBe("# Edited");
  });
});

describe("Claude public factory core and capabilities", () => {
  it("publishes one cancellation receipt when stopped", async () => {
    const transport = installTransport(() => []);
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(transport.optionsSeen.length).toBe(1));
    const canUseTool = transport.optionsSeen[0]?.canUseTool;
    assert(canUseTool);
    const native = canUseTool("Bash", { command: "bun run lint" }, { signal: new AbortController().signal, toolUseID: "tool-1" });
    const pending = await vi.waitFor(() => {
      const [registered] = provider.listPendingApprovals?.() ?? [];
      assert(registered);
      return registered;
    });
    await provider.stopSession("mcode-thread-1");
    await native;
    await vi.waitFor(() => expect(events().filter(({ event }) => event.type === "approvalDecided").map(({ event }) => event)).toEqual([{
      type: "approvalDecided", threadId: "thread-1", requestId: pending.requestId, turnExecutionId: execution1,
      kind: "command", subjectLabel: "bun run lint", outcome: { status: "cancelled", reason: "session_stopped" },
      toolCallId: "tool-1", origin: { kind: "agent" },
    }]));
  });

  it("cancels a closed permission callback without publishing an approval", async () => {
    const transport = installTransport(() => []);
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(transport.optionsSeen.length).toBe(1));
    const canUseTool = transport.optionsSeen[0]?.canUseTool;
    assert(canUseTool);
    const emitted = vi.fn();
    provider.on("approval_request", emitted);
    const controller = new AbortController();
    controller.abort();
    expect(await canUseTool("Bash", { command: "bun run lint" }, { signal: controller.signal, toolUseID: "tool-1" })).toMatchObject({ behavior: "deny" });
    expect(emitted).not.toHaveBeenCalled();
    expect(provider.listPendingApprovals?.()).toEqual([]);
    expect(events().filter(({ event }) => event.type === "approvalDecided")).toEqual([]);
  });

  it.each([
    { response: { choiceId: "deny" }, message: "User denied" },
    { response: { choiceId: "deny", note: "Run bun run test instead" }, message: "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nRun bun run test instead" },
  ])("exposes native command scope and sends the deny message $message", async ({ response, message }) => {
    const transport = installTransport(() => []);
    const { provider } = fixture();
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(transport.optionsSeen.length).toBe(1));
    const canUseTool = transport.optionsSeen[0]?.canUseTool;
    assert(canUseTool);
    const native = canUseTool("Bash", { command: "bun run lint" }, { signal: new AbortController().signal, toolUseID: "tool-approval" });
    const pending = await vi.waitFor(() => {
      const registered = provider.listPendingApprovals?.("thread-1") ?? [];
      expect(registered).toHaveLength(1);
      return registered;
    });
    expect(pending[0]?.body).toMatchObject({
      toolCallId: "tool-approval", subject: { kind: "command", command: "bun run lint" },
      noteChoiceId: "deny", origin: { kind: "agent" },
    });
    expect(await provider.resolveApproval?.(pending[0]!.requestId, response)).toEqual({ status: "resolved" });
    expect(await native).toEqual({ behavior: "deny", message });
    expect(provider.listPendingApprovals?.()).toEqual([]);
  });

  it("emits whole oversized commands and reasons for server validation", async () => {
    const transport = installTransport(() => []);
    const { provider } = fixture();
    await provider.sendTurn(request());
    await vi.waitFor(() => expect(transport.optionsSeen.length).toBe(1));
    const canUseTool = transport.optionsSeen[0]?.canUseTool;
    assert(canUseTool);
    const emitted = vi.fn();
    provider.on("approval_request", emitted);
    const tooLarge = canUseTool("Bash", { command: "x".repeat(70_000) }, { signal: new AbortController().signal, toolUseID: "oversized", decisionReason: "r".repeat(1_001) });
    const oversized = await vi.waitFor(() => {
      const [registered] = provider.listPendingApprovals?.() ?? [];
      assert(registered);
      return registered;
    });
    expect(oversized.body).toMatchObject({ subject: { kind: "command", command: "x".repeat(70_000) }, reason: "r".repeat(1_001) });
    expect(emitted.mock.calls).toEqual([[oversized]]);
    expect(await provider.resolveApproval?.(oversized.requestId, { autoDeny: "too_large" })).toEqual({ status: "resolved" });
    expect(await tooLarge).toMatchObject({ behavior: "deny" });
    expect(provider.listPendingApprovals?.()).toEqual([]);
  });

  it.each([
    ["captured", "## Native plan\nShip it.",
      "The client captured your proposed plan. Reply with a one or two sentence summary of it, then stop and wait for the user to review it."],
    ["oversized", "x".repeat(64 * 1024 + 1),
      "The plan is too long for the client to capture. Shorten it and call ExitPlanMode again."],
    ["empty", "  ", "No plan was received. Write the full plan inside the ````mcode-plan fence in your reply instead."],
  ] as const)("finishes a textless native plan turn without inventing a message: %s", async (kind, markdown, reply) => {
    const decisions: Array<Promise<unknown>> = [];
    installTransport((_turn, options) => {
      assert(options.canUseTool);
      decisions.push(options.canUseTool("ExitPlanMode", { plan: markdown },
        { signal: new AbortController().signal, toolUseID: "PLAN_ONLY" }));
      return [result()];
    });
    const { provider, events } = fixture();
    const capture = vi.fn();
    provider.on("plan_captured", capture);
    await provider.sendTurn(request({ planTurn: { kind: "planning", planFilePath: null } }));
    await completed(events, 1);
    expect(await Promise.all(decisions)).toEqual([{ behavior: "deny", message: reply }]);
    expect(capture.mock.calls).toEqual(kind === "captured" ? [[{ threadId: "thread-1", markdown, source: "native" }]] : []);
    expect(events().filter((runtime) => runtime.event.type === "message" || runtime.planCapture)).toEqual([]);
    expect(events().filter((runtime) => runtime.event.type === "error")).toEqual([]);
  });
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
    await provider.sendTurn(request({ planTurn: { kind: "planning", planFilePath: null } }));
    await completed(events, 1);
    expect(await Promise.all(decisions)).toEqual([{ behavior: "deny",
      message: "The client captured your proposed plan. Reply with a one or two sentence summary of it, then stop and wait for the user to review it." }]);
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
    const permission = new Promise<string>((resolve) => { provider.on("approval_request", (req) => { void provider.resolveApproval?.(req.requestId, { choiceId: "allow" }).then((result) => { expect(result).toEqual({ status: "resolved" }); resolve(req.requestId); }); }); });
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

  it("ends a required resume of a missing conversation without a fresh query", async () => {
    const missing = { type: "result", uuid: "RESUME_MISSING", is_error: true, errors: ["No conversation found with session ID: GONE"] };
    installTransport(() => [missing], false);
    const { provider, events } = fixture();
    await provider.sendTurn(request({ resumeFrom: "GONE", resumeRequired: true }));
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(events().map(({ event }) => event.type)).toContain(AgentEventType.Ended));
    expect(events().find(({ event }) => event.type === AgentEventType.Error)?.event)
      .toMatchObject({ failure: { kind: "fatal", code: "session_resume_unavailable" } });
    expect(events().filter(({ event }) => event.type === AgentEventType.System && event.subtype === "session_restarted")).toEqual([]);
  });

  it("still restarts a missing conversation fresh when resume is not required", async () => {
    const missing = { type: "result", uuid: "RESUME_MISSING", is_error: true, errors: ["No conversation found with session ID: GONE"] };
    installTransport((_turn, options) => options.resume ? [missing] : [result()], false);
    const { provider, events } = fixture();
    await provider.sendTurn(request({ resumeFrom: "GONE" }));
    await completed(events, 1);
    expect(sdkQuery).toHaveBeenCalledTimes(2);
    expect(events().filter(({ event }) => event.type === AgentEventType.System).map(({ event }) => event.subtype)).toContain("session_restarted");
  });

  it("declares only implemented profiles and explicitly excludes native continuation and independent child cancellation", () => {
    const { provider } = fixture();
    expect(provider.descriptor.capabilities.filter(({ support }) => support === "supported").map(({ name }) => name)).toEqual(["build", "plan", "completion", "goals", "permissions", "usage", "session-eviction", "clean-fork", "orchestration", "browser-access", "thread-control", "turn-steer", "session-resume"]);
    expect(provider.descriptor.capabilities).toContainEqual({ name: "provider-continuation", support: "unsupported" });
    expect(provider.descriptor.capabilities).toContainEqual({ name: "child-cancellation", support: "unsupported" });
  });

  it("composes plan controls, goals, orchestration, browser leases and one mcode server", async () => {
    const transport = installTransport();
    const { provider, input, events } = fixture();
    const browser = new BrowserAutomationSessionLease();
    browser.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "fixture" });
    input.host.browser = browser;
    input.host.mcode.attach = vi.fn(async () => mcodeAttachment());
    input.host.mcode.close = vi.fn(async () => undefined);
    await provider.setGoal("mcode-thread-1", "fixture objective");
    await provider.sendTurn(request({ interactionMode: "plan", planTurn: { kind: "planning", planFilePath: null }, orchestrationMode: "proactive" }));
    await completed(events, 1);
    const options = transport.optionsSeen[0];
    assert(options);
    expect(options.mcpServers).toEqual({ mcode: { type: "http", url: "http://127.0.0.1:19400/mcp/mcode", headers: { Authorization: "Bearer fixture-token" } } });
    expect(options.settings).toMatchObject({ ultracode: true });
    expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining("browser_inspect") });
    assert(typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt));
    const append = options.systemPrompt.append ?? "";
    expect(append).toContain("thread_target_list");
    expect(append).not.toContain("Source thread:");
    expect(append).not.toContain("thread-1");
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
    expect(await provider.clearGoal("mcode-thread-1")).toBe(true);
    await provider.discardSession("mcode-thread-1");
    expect(browser.status()).toEqual({ active: 0, pending: 0 });
    expect(input.host.mcode.close).toHaveBeenCalledWith("mcode-thread-1");
    await provider.sendTurn(request({ turnId: "turn-2", turnExecutionId: execution2 }));
    await completed(events, 2);
    expect(sdkQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["thread control only", { browser: false, threadControl: true }, { thread: true, browser: false }],
    ["browser only", { browser: true, threadControl: false }, { thread: false, browser: true }],
    ["neither", { browser: false, threadControl: false }, { thread: false, browser: false }],
  ])("grants instructions from the attached toolkits: %s", async (_name, toolkits, expected) => {
    const transport = installTransport();
    const { provider, input, events } = fixture();
    const browser = new BrowserAutomationSessionLease();
    browser.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "fixture" });
    input.host.browser = browser;
    input.host.mcode.attach = vi.fn(async () => mcodeAttachment(toolkits));
    await provider.sendTurn(request());
    await completed(events, 1);
    const prompt = transport.optionsSeen[0]?.systemPrompt;
    assert(typeof prompt === "object" && !Array.isArray(prompt));
    const append = prompt.append ?? "";
    expect(append.includes("thread_target_list")).toBe(expected.thread);
    expect(append.includes("browser_inspect")).toBe(expected.browser);
  });

  it("emits no Mcode server and grants nothing when the server declines to attach", async () => {
    const transport = installTransport();
    const { provider, events } = fixture();
    await provider.sendTurn(request());
    await completed(events, 1);
    const options = transport.optionsSeen[0];
    expect(options?.mcpServers).toEqual({});
    assert(typeof options?.systemPrompt === "object" && !Array.isArray(options.systemPrompt));
    expect(options.systemPrompt.append ?? "").not.toContain("thread_target_list");
    expect(options.systemPrompt.append ?? "").not.toContain("browser_inspect");
  });

  it("attaches under the session id the Browser lease is staged for, not the resume or thread id", async () => {
    installTransport();
    const { provider, input, events } = fixture();
    const browser = new BrowserAutomationSessionLease();
    browser.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "fixture" });
    const stage = vi.spyOn(browser, "stage");
    input.host.browser = browser;
    const attach = vi.fn(async () => mcodeAttachment());
    input.host.mcode.attach = attach;
    await provider.sendTurn(request({ resumeFrom: "NATIVE_RESUME" }));
    await completed(events, 1);
    const staged = stage.mock.calls[0]?.[0];
    assert(staged);
    expect(staged.providerSessionId).toBe("NATIVE_RESUME");
    expect(attach).toHaveBeenCalledExactlyOnceWith({ providerId: "claude", sessionId: staged.mcodeSessionId, threadId: "thread-1", threadControl: true });
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

  it("stops a turn awaiting attach without starting a query, then accepts a following turn", async () => {
    installTransport();
    const { provider, input, events } = fixture();
    let release!: () => void;
    const attach = new Promise<void>((resolve) => { release = resolve; });
    const attached = vi.fn(async () => { await attach; return null; });
    input.host.mcode.attach = attached;
    const sending = provider.sendTurn(request());
    await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce());
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
    expect(events().flatMap(({ event }) => event.type === AgentEventType.Error ? [event.failure] : [])).toEqual([{ kind: "auth", code: "authentication_failed" }]);
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
