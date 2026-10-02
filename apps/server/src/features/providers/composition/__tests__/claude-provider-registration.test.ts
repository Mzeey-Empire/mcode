import { describe, expect, it, vi } from "vitest";
import type { ProviderFactoryInput, ProviderHostPorts } from "@mcode/providers";
import { registerClaudeProvider } from "../claude-provider-registration.js";

function fixture() {
  const io = vi.fn(() => { throw new Error("Construction must stay inert"); });
  const host: ProviderHostPorts = {
    runtime: { platform: "win32", architecture: "x64", nodeAbi: "127" },
    environment: { snapshot: io },
    processes: { attach: io, terminateTree: io },
    browser: {
      stage: io, releaseSession: io, isConfigured: io, issue: io,
      refresh: io, release: io, revokeCredential: io,
    },
    threadControl: { bootstrap: io, close: io },
    grants: { consume: io },
    events: { submit: io },
  };
  const createForker = vi.fn(() => ({ fork: io }));
  const input: ProviderFactoryInput = {
    configuration: { cliPath: "claude", idleSessionTtlMs: 600_000 },
    host,
    claude: { createForker },
  };
  return { input, io, createForker };
}

describe("registerClaudeProvider", () => {
  it("registers the same inert lifecycle owner under both server tokens", () => {
    const { input, io, createForker } = fixture();
    const registerInstance = vi.fn();

    const provider = registerClaudeProvider({ registerInstance }, input);

    expect(registerInstance.mock.calls).toEqual([
      ["IAgentProvider", provider],
      ["ClaudeProvider", provider],
    ]);
    expect(provider.id).toBe("claude");
    expect(provider.sendTurn).toBeTypeOf("function");
    expect(createForker).toHaveBeenCalledOnce();
    expect(io).not.toHaveBeenCalled();
  });

  it("registers nothing when the required server fork policy is absent", () => {
    const { input, io } = fixture();
    const registerInstance = vi.fn();

    expect(() => registerClaudeProvider({ registerInstance }, { ...input, claude: undefined })).toThrow("createForker");

    expect(registerInstance).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
  });
});
