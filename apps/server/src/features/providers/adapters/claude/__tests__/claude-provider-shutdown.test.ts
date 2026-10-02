import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeProvider } from "../claude-provider.js";
import { AnthropicOAuthUsageSource } from "../usage/oauth-usage-source.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../../../../../runtime/process/containment/__tests__/stub-job-object.js";
import { mockShutdownHost } from "../../../composition/__tests__/helpers/mock-shutdown-host.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("ClaudeProvider shutdown", () => {
  it("waits for a result mapper after native close and delivers its final events", async () => {
    const billingEntered = deferred();
    const billingReleased = deferred();
    const queryClosed = deferred();
    const availability = vi.spyOn(AnthropicOAuthUsageSource.prototype, "isAvailable").mockImplementation(async () => {
      billingEntered.resolve();
      await billingReleased.promise;
      return false;
    });
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const stream = (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        yield { type: "system", subtype: "init", session_id: "sdk-shutdown" };
        yield { type: "result", is_error: false, result: "done", usage: { output_tokens: 1 }, total_cost_usd: 0.01 };
      })();
      return Object.assign(stream, { close: queryClosed.resolve });
    });
    const events: ProviderRuntimeEvent[] = [];
    const provider = new ClaudeProvider(
      stubEnvService(), stubJobObject(), undefined, undefined, undefined,
      mockShutdownHost((event) => events.push(event)),
    );
    let stopping: Promise<void> | undefined;
    try {
      await provider.sendTurn({
        turnId: "turn-shutdown", turnExecutionId: "11111111-1111-4111-8111-111111111111",
        sessionId: "mcode-thread-shutdown", threadId: "thread-shutdown", workspaceId: "workspace-shutdown", message: "hi", cwd: "/tmp",
        model: "claude-sonnet-4-6", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
      });
      await billingEntered.promise;
      let completed = false;
      stopping = provider.shutdown().then(() => { completed = true; });
      await queryClosed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);

      billingReleased.resolve();
      await stopping;
      expect(events.map(({ event }) => event.type)).toEqual(expect.arrayContaining([
        AgentEventType.TurnComplete, AgentEventType.QuotaUpdate, AgentEventType.Ended,
      ]));
    } finally {
      billingReleased.resolve();
      await (stopping ?? provider.shutdown());
      availability.mockRestore();
    }
  });
});
