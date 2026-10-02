import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeProvider, type ClaudeProviderBoundary } from "../index.js";
import { fixtureHost } from "../private/claude/__tests__/helpers/provider-fixture.js";
import { queryMethodStubs } from "../private/claude/__tests__/helpers/mock-sdk-query.js";

const { query, spawn } = vi.hoisted(() => ({ query: vi.fn(), spawn: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn }));

class Child extends NodeEvents.EventEmitter {
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly pid = 12345;
  readonly exitCode = null;
  readonly signalCode = null;
  readonly killed = false;
  kill = vi.fn(() => true);
}
const owned: ClaudeProviderBoundary[] = [];
afterEach(async () => { await Promise.allSettled(owned.splice(0).map((provider) => provider.shutdown())); });
beforeEach(() => { query.mockReset(); spawn.mockReset(); });

function fixture() {
  const child = new Child();
  spawn.mockReturnValue(child);
  const host = fixtureHost();
  host.processes.attach = vi.fn();
  host.processes.terminateTree = vi.fn(async () => undefined);
  const provider = createClaudeProvider({ host, configuration: { cliPath: process.execPath, idleSessionTtlMs: 600_000 }, claude: { createForker: () => ({ fork: async () => { throw new Error("Unused handoff policy"); } }) } });
  owned.push(provider);
  return { provider, child, host };
}
function sdkSpawnOptions(): SpawnOptions { return { command: process.execPath, args: ["fixture.js"], cwd: process.cwd(), env: { FIXTURE: "true" }, signal: new AbortController().signal }; }
function turn() { return { turnId: "turn-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", sessionId: "mcode-thread-1", workspaceId: "workspace-1", threadId: "thread-1", message: "fixture", cwd: process.cwd(), model: "claude-sonnet-4-6", interactionMode: "build" as const, permissionMode: "supervised" as const, providerOptions: {} }; }

function installTransport(spawnNow = true) {
  let options: Options | undefined;
  const spawnOptions = sdkSpawnOptions();
  const close = vi.fn();
  query.mockImplementation(({ prompt, options: sdkOptions }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    options = sdkOptions;
    if (spawnNow) sdkOptions.spawnClaudeCodeProcess?.(spawnOptions);
    const stream = (async function* () {
      for await (const _input of prompt) yield { type: "result", is_error: false, result: "fixture" };
    })();
    return Object.assign(stream, queryMethodStubs(), { close });
  });
  return { spawnOptions, close, lateSpawn: () => options?.spawnClaudeCodeProcess?.(spawnOptions) };
}

describe("Claude factory SDK process ownership", () => {
  it("captures exactly the SDK-created persistent process and forwards signal, environment and pipes", async () => {
    const { provider, host, child } = fixture();
    const transport = installTransport();
    await provider.sendTurn(turn());
    expect(spawn).toHaveBeenCalledWith(transport.spawnOptions.command, transport.spawnOptions.args, { cwd: transport.spawnOptions.cwd, env: transport.spawnOptions.env, signal: transport.spawnOptions.signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(host.processes.attach).toHaveBeenCalledExactlyOnceWith(child.pid, "Claude mcode-thread-1");
    await provider.stopSession("mcode-thread-1");
    await provider.stopSession("mcode-thread-1");
    expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("retires an ephemeral completion process", async () => {
    const { provider, host, child } = fixture();
    installTransport();
    expect(await provider.complete("fixture", "claude-sonnet-4-6", process.cwd())).toBe("fixture");
    expect(host.processes.attach).toHaveBeenCalledExactlyOnceWith(child.pid, "Claude completion");
    expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("retires a callback process when query construction throws before runtime admission", async () => {
    const { provider, host, child } = fixture();
    query.mockImplementation(({ options }: { options: Options }) => { options.spawnClaudeCodeProcess?.(sdkSpawnOptions()); throw new Error("SDK construction failed"); });
    await expect(provider.sendTurn(turn())).rejects.toThrow("SDK construction failed");
    expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("retires the captured process when containment attachment rejects", async () => {
    const { provider, host, child } = fixture();
    host.processes.attach = () => { throw new Error("containment rejected"); };
    installTransport();
    await expect(provider.sendTurn(turn())).rejects.toThrow("containment rejected");
    expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("retires a late SDK spawn callback after session stop", async () => {
    const { provider, host, child } = fixture();
    const transport = installTransport(false);
    await provider.sendTurn(turn());
    await provider.stopSession("mcode-thread-1");
    transport.lateSpawn();
    await vi.waitFor(() => expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid));
  });

  it("still closes and retires the query when thread-control cleanup rejects", async () => {
    const { provider, host, child } = fixture();
    const transport = installTransport();
    await provider.sendTurn(turn());
    host.threadControl.close = async () => { throw new Error("thread-control cleanup failed"); };
    await expect(provider.stopSession("mcode-thread-1")).rejects.toThrow("Claude session cleanup failed");
    expect(transport.close).toHaveBeenCalledOnce();
    expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(child.pid);
    await expect(provider.shutdown()).rejects.toThrow("Claude provider shutdown failed");
  });
});
