import { describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeProvider } from "./helpers/provider-fixture.js";
import { AnthropicOAuthUsageSource } from "../usage/oauth-usage-source.js";
import { stubEnvService } from "./helpers/provider-fixture.js";
import { stubJobObject } from "./helpers/provider-fixture.js";
import { mockShutdownHost } from "./helpers/mock-shutdown-host.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("ClaudeProvider shutdown", () => {
  it.each(["shutdown", "stop"])("%s releases a paused SDK iterator and saves its real tail", async (action) => {
    const held = deferred();
    const closed = deferred();
    let pulled = 0;
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const stream = (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        yield { type: "system", subtype: "init", session_id: "sdk-paused" };
        yield { type: "stream_event", event: { type: "message_start", message: { id: "message-paused" } } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
        for (let index = 0; index < 1_500; index++) {
          pulled++;
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: String(index) } } };
        }
        yield { type: "result", is_error: false, result: "done", usage: { output_tokens: 1 }, total_cost_usd: 0.01 };
      })();
      return Object.assign(stream, { close: closed.resolve });
    });
    const events: ProviderRuntimeEvent[] = [];
    const host = mockShutdownHost((event) => events.push(event));
    const submit = host.events.submit;
    host.events = { submit: async (batch) => { await held.promise; return submit(batch); } };
    const provider = new ClaudeProvider(stubEnvService(), stubJobObject(), undefined, undefined, undefined, host);
    try {
      await provider.sendTurn({
        turnId: "turn-paused", turnExecutionId: "11111111-1111-4111-8111-111111111111",
        sessionId: "mcode-thread-paused", threadId: "thread-paused", workspaceId: "workspace-paused", message: "hi", cwd: "/tmp",
        model: "claude-sonnet-4-6", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
      });
      await vi.waitFor(() => expect(pulled).toBeGreaterThan(100));
      expect(pulled).toBeLessThan(1_500);
      const stopping = action === "shutdown" ? provider.shutdown() : provider.stopSession("mcode-thread-paused");
      await closed.promise;
      if (action === "stop") await stopping;
      held.resolve();
      await stopping;
      await provider.shutdown();
      expect(events.filter(({ event }) => event.type === "textDelta").map(({ event }) =>
        event.type === "textDelta" ? event.delta : "")).toEqual(Array.from({ length: 1_500 }, (_, index) => String(index)));
      expect(events.filter(({ event }) => event.type === "turnComplete")).toHaveLength(1);
    } finally {
      held.resolve();
      await provider.shutdown();
    }
  });

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
