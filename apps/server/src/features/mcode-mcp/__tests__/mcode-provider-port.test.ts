import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeProvider, type ClaudeProviderBoundary } from "@mcode/providers";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { BrowserAutomationSessionLease } from "../../browser-automation/access/browser-automation-session-lease.js";
import { McodeProviderPort } from "../mcode-provider-port.js";
import { McodeSessionAuthority } from "../mcode-session-authority.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));

const providers: ClaudeProviderBoundary[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  query.mockReset();
});

const request = { providerId: "claude", sessionId: "session-a", threadId: "thread-a", threadControl: true };

function createPort(options: { endpoint?: string | null; browser?: boolean } = {}) {
  const authority = new McodeSessionAuthority();
  const server = {
    endpoint: vi.fn(() => (options.endpoint === undefined ? "http://127.0.0.1:4000/mcp/mcode" : options.endpoint)),
    closeSession: vi.fn(async () => undefined),
  };
  const port = new McodeProviderPort({
    authority,
    server: () => server,
    isBrowserConfigured: () => options.browser ?? true,
  });
  return { authority, server, port };
}

function createClaudeFixture(port: McodeProviderPort) {
  const provider = createClaudeProvider({
    configuration: { cliPath: process.execPath, idleSessionTtlMs: 60_000 },
    host: {
      runtime: hostRuntime,
      environment: { snapshot: () => ({}) },
      processes: { attach: () => undefined, terminateTree: async () => undefined },
      browser: new BrowserAutomationSessionLease(),
      mcode: port,
      grants: { consume: () => false },
      events: { submit: async () => ({
        commit: { outcome: "committed", conversationRevision: 1, rosterRevision: 0,
          acceptedThrough: 1, durableThrough: 1, eventCount: 1 },
        delivery: { ingress: "queued" },
      }) },
      turns: { open: async () => ({ kind: "declined", reason: "unavailable" }), settleBackgroundTool: async () => undefined },
    },
  });
  providers.push(provider);
  return provider;
}

describe("McodeProviderPort", () => {
  it.each([false, true])("keeps replacement Claude credentials valid after failed cleanup with active lease = %s", async (activeLease) => {
    const { authority, server, port } = createPort();
    const optionsSeen: Options[] = [];
    query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
      optionsSeen.push(options);
      const stream = (async function* () {
        for await (const _input of prompt) yield { type: "result", is_error: false };
      })();
      return Object.assign(stream, { close: () => undefined });
    });
    const provider = createClaudeFixture(port);
    const turn = {
      turnId: "turn-1", turnExecutionId: "00000000-0000-4000-8000-000000000001",
      sessionId: "mcode-thread-a", workspaceId: "workspace-a", threadId: "thread-a",
      message: "fixture", cwd: process.cwd(), model: "claude-haiku-4-5",
      interactionMode: "build", permissionMode: "full", providerOptions: {},
    } satisfies Parameters<typeof provider.sendTurn>[0];
    await provider.sendTurn(turn);
    server.closeSession.mockRejectedValueOnce(new Error("transport close failed"));
    await expect(provider.stopSession(turn.sessionId)).rejects.toThrow("Claude session cleanup failed");
    if (activeLease) authority.activate({
      sessionId: turn.sessionId, sourceThreadId: turn.threadId, sourceTurnId: "turn-2",
      sourceProviderId: "claude", permissionMode: "full",
    });

    await provider.sendTurn({ ...turn, turnId: "turn-2", turnExecutionId: "00000000-0000-4000-8000-000000000002" });

    expect(optionsSeen).toHaveLength(2);
    const mcode = optionsSeen[1]?.mcpServers?.mcode;
    assert(mcode && "headers" in mcode);
    const token = mcode.headers?.Authorization?.slice("Bearer ".length);
    assert(token);
    expect(authority.resolve(token)).toEqual({
      providerId: "claude", sessionId: turn.sessionId, threadId: turn.threadId, threadControl: true,
    });
  });

  it("returns the endpoint and a token that resolves to the attached session", async () => {
    const { authority, port } = createPort();

    const attachment = await port.attach(request);

    expect(attachment).toMatchObject({
      serverName: "mcode",
      url: "http://127.0.0.1:4000/mcp/mcode",
      toolkits: { browser: true, threadControl: true, visuals: true },
    });
    expect(authority.resolve(attachment?.token ?? "")).toMatchObject({ sessionId: "session-a", threadId: "thread-a" });
  });

  it("attaches nothing before the server is listening", async () => {
    const { authority, port } = createPort({ endpoint: null });

    expect(await port.attach(request)).toBeNull();
    expect(authority.credential("session-a")).toBeUndefined();
  });

  it("attaches nothing when neither toolkit applies, and reports which toolkits do", async () => {
    const { port } = createPort({ browser: false });

    expect(await port.attach({ ...request, threadControl: false })).toBeNull();
    expect(await port.attach(request)).toMatchObject({ toolkits: { browser: false, threadControl: true, visuals: true } });
  });

  it("revokes the token and ends in-flight requests when the session closes", async () => {
    const { authority, server, port } = createPort();
    const attachment = await port.attach(request);

    await port.close("session-a");

    expect(authority.resolve(attachment?.token ?? "")).toBeNull();
    expect(server.closeSession).toHaveBeenCalledWith("session-a");
  });

  it.each([true, false])("attaches visuals only with thread control = %s", async (threadControl) => {
    const { port } = createPort({ browser: true });
    const attachment = await port.attach({ ...request, threadControl });
    expect(attachment?.toolkits.visuals).toBe(threadControl);
  });
});
