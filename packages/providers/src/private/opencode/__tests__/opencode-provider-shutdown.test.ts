import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import { mockShutdownHost } from "../../__tests__/helpers/mock-shutdown-host.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("OpenCodeProvider shutdown", () => {
  it("waits for an admitted CLI probe and delivers the turn's terminal events", async () => {
    const probeEntered = deferred();
    const probeReleased = deferred();
    const events: ProviderRuntimeEvent[] = [];
    const host = mockShutdownHost((event) => events.push(event));
    const provider = new OpenCodeProvider(host, {
      settings: { get: getDefaultSettings },
      processScope: { create: () => null },
    });
    const pool = new OpenCodeServerPool({
      spawn: () => { throw new Error("Unexpected native spawn after shutdown"); },
      waitForHealth: async () => {}, terminateTree: async () => {},
      findFreePort: async () => 4096, now: () => Date.now(), env: () => ({}),
    });
    provider.configureTestSeams({
      pool,
      probeCli: async () => {
        probeEntered.resolve();
        await probeReleased.promise;
        return { binaryPath: "opencode", version: "test" };
      },
    });
    let turning: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      turning = provider.sendTurn({
        turnId: "turn-shutdown", turnExecutionId: "11111111-1111-4111-8111-111111111111",
        sessionId: "mcode-thread-shutdown", threadId: "thread-shutdown", workspaceId: "workspace-shutdown", message: "hi", cwd: "/tmp",
        model: "anthropic/claude-sonnet-4-6", permissionMode: "full", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
      });
      await probeEntered.promise;
      let completed = false;
      stopping = provider.shutdown().then(() => { completed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);

      probeReleased.resolve();
      await Promise.all([turning, stopping]);
      expect(events.map(({ event }) => event.type)).toEqual([
        AgentEventType.TurnStarted, AgentEventType.Error, AgentEventType.Ended,
      ]);
    } finally {
      probeReleased.resolve();
      await Promise.all([turning, stopping ?? provider.shutdown()]);
    }
  });
});
