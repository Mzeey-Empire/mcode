import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Options, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/**
 * Minimal SDK mock returning an async generator that yields one "result"
 * message per user message pushed to the prompt queue. The generator also
 * exposes `setModel`, `interrupt`, and `close` so the provider's existing-session
 * logic (including teardown on permissionMode change) can call them without blowing up.
 */
function makeFakeSdkQuery(
  pushCalls: Array<{ options: Options }>,
  flagSettingsCalls: Array<Record<string, unknown>>,
  turnFinished?: Promise<void>,
) {
  return ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options: Options;
  }) => {
    pushCalls.push({ options });
    const iterator = prompt[Symbol.asyncIterator]();

    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        const userMsg = await iterator.next();
        if (userMsg.done) {
          return { value: undefined as unknown as Record<string, unknown>, done: true };
        }
        await turnFinished;
        return {
          value: {
            type: "result",
            is_error: false,
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          },
          done: false,
        };
      },
      async return() {
        return { value: undefined as unknown as Record<string, unknown>, done: true };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    Object.assign(generator, {
      setModel: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async (settings: Record<string, unknown>) => {
        flagSettingsCalls.push(settings);
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });

    return generator;
  };
}

const { sdkCalls, mockQuery } = vi.hoisted(() => {
  const sdkCalls: Array<{ options: Options }> = [];
  return { sdkCalls, mockQuery: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "./helpers/provider-fixture.js";
import { stubEnvService } from "./helpers/provider-fixture.js";
import { stubJobObject } from "./helpers/provider-fixture.js";
import {
  BrowserAutomationCredentialRegistry,
  BrowserAutomationSessionLease,
} from "./helpers/provider-fixture.js";
import { mockProviderHost } from "./helpers/mock-sdk-query.js";

describe("ClaudeProvider permission mode changes", () => {
  let provider: ClaudeProvider;
  const flagSettingsCalls: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    sdkCalls.length = 0;
    flagSettingsCalls.length = 0;
    mockQuery.mockImplementation(makeFakeSdkQuery(sdkCalls, flagSettingsCalls));
    provider = new ClaudeProvider(
      stubEnvService(),
      stubJobObject(),
      undefined,
      undefined,
      undefined,
      mockProviderHost(),
    );
  });

  async function askWithSuggestions(suggestions?: PermissionUpdate[]) {
    const turnFinished = Promise.withResolvers<void>();
    mockQuery.mockImplementation(makeFakeSdkQuery(sdkCalls, flagSettingsCalls, turnFinished.promise));
    await provider.sendTurn({
      turnExecutionId: "test-execution", sessionId: "mcode-scope", threadId: "scope",
      message: "run npm test", cwd: process.cwd(), model: "claude-sonnet-4-6",
      permissionMode: "supervised", interactionMode: "build", providerOptions: {},
    });
    const canUseTool = sdkCalls[0]?.options.canUseTool;
    if (!canUseTool) throw new Error("Missing native permission callback");
    const result = canUseTool("Bash", { command: "npm test" }, {
      signal: new AbortController().signal, toolUseID: "bash-1", suggestions,
    });
    await vi.waitFor(() => expect(provider.listPendingApprovals("scope")).toHaveLength(1));
    const [pending] = provider.listPendingApprovals("scope");
    if (!pending) throw new Error("Missing approval");
    return { result, pending, finishTurn: turnFinished.resolve };
  }

  it("describes every suggested update and confines native permissions to the session", async () => {
    const { result, pending, finishTurn } = await askWithSuggestions([
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], destination: "userSettings" },
      { type: "replaceRules", behavior: "ask", rules: [{ toolName: "Read", ruleContent: "src/**" }], destination: "projectSettings" },
      { type: "removeRules", behavior: "deny", rules: [{ toolName: "Write" }], destination: "localSettings" },
      { type: "addDirectories", directories: ["/fixture/src"], destination: "cliArg" },
      { type: "removeDirectories", directories: ["/fixture/tmp"], destination: "session" },
    ]);
    expect(pending.body.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "allow-session", intent: "allow_scoped", label: "Allow for this session", description: "Add session allow rules for: npm test commands; Replace all session ask rules with: Read(src/**); Remove session deny rules for: all Write uses; Add accessible directories: /fixture/src; Remove accessible directories: /fixture/tmp" },
      { id: "deny", intent: "deny", label: "Deny" },
    ]);
    expect(await provider.resolveApproval(pending.requestId, { choiceId: "allow-session" })).toEqual({ status: "resolved" });
    expect(await result).toEqual({ behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], destination: "session" },
      { type: "replaceRules", behavior: "ask", rules: [{ toolName: "Read", ruleContent: "src/**" }], destination: "session" },
      { type: "removeRules", behavior: "deny", rules: [{ toolName: "Write" }], destination: "session" },
      { type: "addDirectories", directories: ["/fixture/src"], destination: "session" },
      { type: "removeDirectories", directories: ["/fixture/tmp"], destination: "session" },
    ] });
    finishTurn();
    await provider.stopSession("mcode-scope");
  });

  it.each<{ name: string; suggestions?: PermissionUpdate[] }>([
    { name: "missing suggestions" },
    { name: "empty suggestions", suggestions: [] },
    { name: "empty rule content", suggestions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "" }], destination: "session" },
    ] },
    { name: "an empty command prefix", suggestions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: ":*" }], destination: "session" },
    ] },
    { name: "a blank command prefix mixed with a rule", suggestions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: " \t:*" }], destination: "session" },
    ] },
    { name: "an unknown update mixed with a rule", suggestions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }], destination: "session" },
      JSON.parse('{"type":"futureUpdate","destination":"userSettings"}'),
    ] },
    { name: "missing rules", suggestions: [JSON.parse('{"type":"addRules","behavior":"allow","destination":"session"}')] },
    { name: "missing directories", suggestions: [JSON.parse('{"type":"addDirectories","destination":"session"}')] },
    { name: "malformed rules", suggestions: [JSON.parse('{"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":42}],"destination":"session"}')] },
    { name: "malformed directories", suggestions: [JSON.parse('{"type":"removeDirectories","directories":[42],"destination":"session"}')] },
    { name: "unknown rule behavior", suggestions: [JSON.parse('{"type":"addRules","behavior":"futureBehavior","rules":[{"toolName":"Read"}],"destination":"session"}')] },
    { name: "a mode switch mixed with a rule", suggestions: [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }], destination: "session" },
      { type: "setMode", mode: "bypassPermissions", destination: "localSettings" },
    ] },
  ])("keeps deny and omits an unstatable session choice: $name", async ({ suggestions }) => {
    const { result, pending, finishTurn } = await askWithSuggestions(suggestions);
    expect(pending.body.choices).toEqual([
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "deny", intent: "deny", label: "Deny" },
    ]);
    expect(await provider.resolveApproval(pending.requestId, { choiceId: "allow-session" })).toMatchObject({ status: "failed" });
    await provider.resolveApproval(pending.requestId, { choiceId: "deny" });
    expect(await result).toMatchObject({ behavior: "deny" });
    finishTurn();
    await provider.stopSession("mcode-scope");
  });

  it.each([472, 473])("never truncates a directory scope of length %s", async (length) => {
    const { result, pending, finishTurn } = await askWithSuggestions([
      { type: "addDirectories", directories: ["x".repeat(length)], destination: "projectSettings" },
    ]);
    const scoped = pending.body.choices.find((choice) => choice.id === "allow-session");
    if (length === 472) expect(scoped?.description).toBe("Add accessible directories: " + "x".repeat(472));
    else expect(scoped).toBeUndefined();
    expect(pending.body.choices.at(-1)).toEqual({ id: "deny", intent: "deny", label: "Deny" });
    await provider.resolveApproval(pending.requestId, { choiceId: "allow" });
    expect(await result).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    finishTurn();
    await provider.stopSession("mcode-scope");
  });

  it("passes the one mcode server through query options without touching process.env", async () => {
    const credentials = new BrowserAutomationCredentialRegistry();
    const lease = new BrowserAutomationSessionLease(credentials);
    lease.configure({
      worktreeIdentity: "worktree-test",
    });
    provider = new ClaudeProvider(
      stubEnvService(),
      stubJobObject(),
      undefined,
      lease,
      undefined,
      {
        ...mockProviderHost(),
        mcode: {
          attach: async () => ({ serverName: "mcode", url: "http://127.0.0.1:19400/mcp/mcode", token: "session-token-0123456789", toolkits: { browser: true, threadControl: true } }),
          close: async () => undefined,
        },
      },
    );

    try {
      await provider.sendTurn({
      turnExecutionId: "test-execution",
        sessionId: "mcode-browser-claude",
        workspaceId: "workspace-test",
        threadId: "browser-claude",
        message: "inspect the page",
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
        permissionMode: "supervised",
        interactionMode: "build",
        providerOptions: {},
      });

      expect(sdkCalls[0]!.options.mcpServers).toEqual({
        mcode: {
          type: "http",
          url: "http://127.0.0.1:19400/mcp/mcode",
          headers: { Authorization: "Bearer session-token-0123456789" },
        },
      });
      expect(process.env.MCODE_MCP_TOKEN).toBeUndefined();
      await provider.stopSession("mcode-browser-claude");
    } finally {
      lease.shutdown();
    }
    expect(credentials.size()).toBe(0);
  });

  it("asks the CLI to report startup failures as classifiable results", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-startup-results",
      threadId: "startup-results",
      message: "hello",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });

    expect(sdkCalls[0]!.options.env).toMatchObject({ CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" });
    await provider.stopSession("mcode-startup-results");
  });

  it("reuses the session when permissionMode is unchanged", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-a",
      threadId: "thread-a",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-a",
      threadId: "thread-a",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });

    // One underlying sdk subprocess for both messages.
    expect(sdkCalls.length).toBe(1);
  });

  it("tears down and respawns the session when permissionMode changes", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-b",
      threadId: "thread-b",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-b",
      threadId: "thread-b",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      interactionMode: "build",
      providerOptions: {},
    });

    // The SDK subprocess is respawned because permissionMode is fixed at spawn.
    expect(sdkCalls.length).toBe(2);

    // First spawn was in supervised (SDK "default") mode with no bypass flag.
    expect(sdkCalls[0]!.options.permissionMode).toBe("default");
    expect(sdkCalls[0]!.options.allowDangerouslySkipPermissions).toBeUndefined();

    // Second spawn is in full (SDK "bypassPermissions") mode and is allowed to return to bypass after a Plan turn.
    expect(sdkCalls[1]!.options.permissionMode).toBe("bypassPermissions");
    expect(sdkCalls[1]!.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("starts proactive sessions with Ultracode enabled", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-ultracode-new",
      threadId: "ultracode-new",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      permissionMode: "supervised",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
    });

    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]!.options.settings).toMatchObject({ ultracode: true });
  });

  it("applies Ultracode when orchestration changes on a reusable session", async () => {
    const baseRequest = {
      sessionId: "mcode-ultracode-toggle",
      threadId: "ultracode-toggle",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      permissionMode: "supervised" as const,
      interactionMode: "build" as const,
      providerOptions: {},
    };
    await provider.sendTurn({
      turnExecutionId: "test-execution", ...baseRequest, message: "first", orchestrationMode: "standard" });
    await provider.sendTurn({
      turnExecutionId: "test-execution", ...baseRequest, message: "second", orchestrationMode: "proactive" });

    expect(sdkCalls).toHaveLength(1);
    expect(flagSettingsCalls).toEqual([{ ultracode: true }]);
  });
});
