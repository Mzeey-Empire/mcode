import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import type { McpServer } from "@agentclientprotocol/sdk";
import { getDefaultSettings, type TurnRequest } from "@mcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderHostPorts, ProviderMcodeAttachment } from "../../../host-ports.js";
import { AcpSessionRuntime } from "../../protocols/acp/acp-session-runtime.js";
import { CursorProvider } from "../cursor-provider.js";

const THREAD_TOOL = "thread_target_list";
const BROWSER_TOOL = "browser_inspect";

function attachment(toolkits: ProviderMcodeAttachment["toolkits"] = { browser: true, threadControl: true }): ProviderMcodeAttachment {
  return { serverName: "mcode", url: "http://127.0.0.1:19400/mcp/mcode", token: "mcode-token", toolkits };
}

function createHost(): ProviderHostPorts {
  return {
    runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: vi.fn(() => ({})) },
    processes: { attach: vi.fn(), terminateTree: vi.fn(async () => undefined) },
    browser: {
      stage: vi.fn(() => ({ leaseId: "lease-1", expiresAt: Date.now() + 60_000 })),
      releaseSession: vi.fn(() => 0),
      isConfigured: vi.fn(() => true),
      issue: vi.fn((handle) => ({
        ...handle,
        credentialId: "credential-1",
        allowedOperations: ["browser.list_tabs"],
      })),
      refresh: vi.fn(() => ({ ok: false as const, leaseId: "lease-1", reason: "unconfigured" as const })),
      release: vi.fn((leaseId: string) => ({ leaseId, released: true })),
      revokeCredential: vi.fn(() => false),
    },
    mcode: { attach: vi.fn(async () => attachment()), close: vi.fn(async () => undefined) },
    grants: { consume: vi.fn(() => false) },
    events: {
      submit: vi.fn(async () => ({
        commit: { outcome: "committed" as const, conversationRevision: 1, rosterRevision: 1, acceptedThrough: 1, durableThrough: 1, eventCount: 1 },
        delivery: { ingress: "queued" as const },
      })),
    },
  };
}

function createFakeAcpRuntime(acpSessionId: string, pid: number) {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as NodeChildProcess.ChildProcess;
  const state = { child, connection: { unstable_setSessionModel: vi.fn(async () => ({})) }, sessionId: "", agentCapabilities: {}, activePrompt: null };
  return {
    state,
    initialize: vi.fn(async () => ({ agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] })),
    openSession: vi.fn(async (_request: { mcpServers: McpServer[] }) => {
      state.sessionId = acpSessionId;
      return { sessionId: acpSessionId, reloaded: false };
    }),
    prompt: vi.fn(async (_request: { prompt: unknown }) => ({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function turn(): TurnRequest<"cursor"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "execution-1",
    sessionId: "mcode-thread-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    message: "prompt",
    cwd: ".",
    model: "cursor-model",
    permissionMode: "default",
    interactionMode: "build",
    providerOptions: {},
  };
}

const providers: CursorProvider[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(providers.splice(0).map((provider) => (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown()));
});

function startProvider(host: ProviderHostPorts, runtimes: Array<ReturnType<typeof createFakeAcpRuntime>>): CursorProvider {
  vi.spyOn(AcpSessionRuntime, "start").mockImplementation(async () => {
    const next = runtimes.shift();
    if (!next) throw new Error("Unexpected Cursor ACP spawn");
    return next as unknown as AcpSessionRuntime;
  });
  const provider = new CursorProvider(host, { settings: { get: () => getDefaultSettings() }, skills: { list: () => [] } }, 60_000);
  providers.push(provider);
  return provider;
}

function openedServers(fake: ReturnType<typeof createFakeAcpRuntime>): McpServer[] {
  return fake.openSession.mock.calls[0]?.[0].mcpServers ?? [];
}

function promptText(fake: ReturnType<typeof createFakeAcpRuntime>): string {
  return JSON.stringify(fake.prompt.mock.calls[0]?.[0].prompt);
}

describe("Cursor reaches Mcode tools through one mcode server", () => {
  it("opens the session with exactly one mcode entry and grants both toolkits", async () => {
    const host = createHost();
    const fake = createFakeAcpRuntime("acp-1", 101);
    await startProvider(host, [fake]).sendTurn(turn());

    expect(openedServers(fake)).toEqual([{
      type: "http",
      name: "mcode",
      url: "http://127.0.0.1:19400/mcp/mcode",
      headers: [{ name: "Authorization", value: "Bearer mcode-token" }],
    }]);
    expect(promptText(fake)).toContain(THREAD_TOOL);
    expect(promptText(fake)).toContain(BROWSER_TOOL);
  });

  it("attaches under the session id the Browser lease is staged for", async () => {
    const host = createHost();
    await startProvider(host, [createFakeAcpRuntime("acp-1", 101)]).sendTurn(turn());

    const staged = vi.mocked(host.browser.stage).mock.calls[0]?.[0];
    expect(staged?.mcodeSessionId).toBe("mcode-thread-1");
    expect(host.mcode.attach).toHaveBeenCalledExactlyOnceWith({
      providerId: "cursor",
      sessionId: staged?.mcodeSessionId,
      threadId: "thread-1",
      threadControl: true,
    });
  });

  it("grants only the toolkits the server lists", async () => {
    const host = createHost();
    vi.mocked(host.mcode.attach).mockResolvedValue(attachment({ browser: false, threadControl: true }));
    const fake = createFakeAcpRuntime("acp-1", 101);
    await startProvider(host, [fake]).sendTurn(turn());

    expect(promptText(fake)).toContain(THREAD_TOOL);
    expect(promptText(fake)).not.toContain(BROWSER_TOOL);
    expect(host.browser.release).toHaveBeenCalledWith("lease-1");
  });

  it("continues with no Mcode entry and grants neither toolkit when attach rejects", async () => {
    const host = createHost();
    vi.mocked(host.mcode.attach).mockRejectedValue(new Error("mcode server unavailable"));
    const fake = createFakeAcpRuntime("acp-1", 101);
    await startProvider(host, [fake]).sendTurn(turn());

    expect(openedServers(fake)).toEqual([]);
    expect(promptText(fake)).not.toContain(THREAD_TOOL);
    expect(promptText(fake)).not.toContain(BROWSER_TOOL);
    expect(host.browser.release).toHaveBeenCalledWith("lease-1");
  });

  it("retries on a fresh process without the mcode entry when Cursor rejects its connection", async () => {
    const host = createHost();
    const first = createFakeAcpRuntime("acp-1", 101);
    const second = createFakeAcpRuntime("acp-2", 202);
    first.openSession.mockRejectedValue(new Error("MCP connection closed"));
    await startProvider(host, [first, second]).sendTurn(turn());

    expect(openedServers(first)).toHaveLength(1);
    expect(openedServers(second)).toEqual([]);
    expect(promptText(second)).not.toContain(THREAD_TOOL);
    expect(promptText(second)).not.toContain(BROWSER_TOOL);
    expect(host.mcode.close).toHaveBeenCalledWith("mcode-thread-1");
  });

  it("closes the mcode session when the pooled session is torn down", async () => {
    const host = createHost();
    const provider = startProvider(host, [createFakeAcpRuntime("acp-1", 101)]);
    await provider.sendTurn(turn());
    await provider.discardSession("mcode-thread-1");

    expect(host.mcode.close).toHaveBeenCalledWith("mcode-thread-1");
  });
});
