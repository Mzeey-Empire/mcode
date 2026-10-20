import { describe, expect, it, vi } from "vitest";
import type { IAgentProvider, Settings } from "@mcode/contracts";
import type { ProviderFactoryInput, ProviderHostPorts } from "@mcode/providers";
import { registerClaudeProvider } from "../claude-provider-registration.js";
import { registerCodexProvider } from "../codex-provider-registration.js";
import { registerCursorProvider } from "../cursor-provider-registration.js";

function inertHost(platform: NodeJS.Platform) {
  const io = vi.fn(() => { throw new Error("Construction must stay inert"); });
  const host: ProviderHostPorts = {
    runtime: { platform, architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: io },
    processes: { attach: io, terminateTree: io },
    browser: {
      stage: io, releaseSession: io, isConfigured: io, issue: io,
      refresh: io, release: io, revokeCredential: io,
    },
    mcode: { attach: io, close: io },
    grants: { consume: io },
    events: { submit: io },
    turns: { open: io, settleBackgroundTool: io },
  };
  return { host, io };
}

type Register = (registry: { registerInstance: (token: string, provider: IAgentProvider) => unknown }, input: ProviderFactoryInput) => IAgentProvider;

const createForker = vi.fn(() => ({ fork: vi.fn() }));

const cases: ReadonlyArray<{
  id: string;
  platform: NodeJS.Platform;
  register: Register;
  input: (host: ProviderHostPorts) => ProviderFactoryInput;
  tokens: readonly string[];
  forkerCalls: number;
}> = [
  {
    id: "claude",
    platform: "win32",
    register: registerClaudeProvider,
    input: (host) => ({
      configuration: { cliPath: "claude", idleSessionTtlMs: 600_000 },
      host,
      claude: { createForker },
    }),
    tokens: ["IAgentProvider", "ClaudeProvider"],
    forkerCalls: 1,
  },
  {
    id: "codex",
    platform: "linux",
    register: registerCodexProvider,
    input: (host) => ({
      configuration: { cliPath: "codex", idleSessionTtlMs: 600_000 },
      host,
      codex: {
        settings: { get: vi.fn(async () => ({ cliPath: "codex", fastMode: false })) },
        attachments: { persistGeneratedImageFromPath: vi.fn() },
        catalog: {
          currentSkills: vi.fn(() => []),
          listModels: vi.fn(async () => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
          shutdown: vi.fn(async () => undefined),
        },
      },
    }) as unknown as ProviderFactoryInput,
    tokens: ["IAgentProvider"],
    forkerCalls: 0,
  },
  {
    id: "cursor",
    platform: "linux",
    register: registerCursorProvider,
    input: (host) => ({
      configuration: { cliPath: "cursor-agent", idleSessionTtlMs: 600_000 },
      host,
      cursor: {
        settings: { get: () => ({} as Settings) },
        skills: { list: () => [] },
      },
    }),
    tokens: ["IAgentProvider"],
    forkerCalls: 0,
  },
];

describe("provider registration", () => {
  it.each(cases)("registers one usable $id lifecycle owner under its server tokens without host I/O", ({ id, platform, register, input, tokens, forkerCalls }) => {
    const { host, io } = inertHost(platform);
    const registerInstance = vi.fn();
    createForker.mockClear();

    const provider = register({ registerInstance }, input(host));

    expect(registerInstance.mock.calls).toEqual(tokens.map((token) => [token, provider]));
    expect(provider.id).toBe(id);
    expect(provider.sendTurn).toBeTypeOf("function");
    expect(io).not.toHaveBeenCalled();
    expect(createForker).toHaveBeenCalledTimes(forkerCalls);
  });

  it("registers no Claude provider when the required server fork policy is absent", () => {
    const { host, io } = inertHost("win32");
    const registerInstance = vi.fn();
    const input: ProviderFactoryInput = { configuration: { cliPath: "claude", idleSessionTtlMs: 600_000 }, host };

    expect(() => registerClaudeProvider({ registerInstance }, input)).toThrow("createForker");

    expect(registerInstance).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
  });
});
