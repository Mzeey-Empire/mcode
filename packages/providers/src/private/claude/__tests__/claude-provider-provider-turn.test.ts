import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderTurnOpening } from "@mcode/providers";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeProvider, stubEnvService, stubJobObject } from "./helpers/provider-fixture.js";
import { mockShutdownHost } from "./helpers/mock-shutdown-host.js";

const USER_EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const PROVIDER_EXECUTION_ID = "66666666-6666-4666-8666-666666666666";
const SUMMARY = "Background command \"sleep 20\" completed";

/** Replays the measured SDK sequence: a user turn, then a self-started turn after a background task finishes. */
function backgroundTaskQuery() {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closeSession!: () => void;
    const closed = new Promise<void>((resolve) => { closeSession = resolve; });
    const stream = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "result", is_error: false, result: "started", usage: { output_tokens: 1 } };
      yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", summary: SUMMARY };
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The background task finished." }] } };
      yield { type: "result", is_error: false, result: "The background task finished.", usage: { output_tokens: 6 } };
      await closed;
    })();
    return Object.assign(stream, { close: closeSession });
  };
}

async function runBackgroundTask(opening: ProviderTurnOpening) {
  mockQuery.mockImplementation(backgroundTaskQuery());
  const events: ProviderRuntimeEvent[] = [];
  const open = vi.fn(async () => opening);
  const provider = new ClaudeProvider(
    stubEnvService(), stubJobObject(), undefined, undefined, undefined,
    mockShutdownHost((event) => events.push(event), { open }),
  );
  try {
    await provider.sendTurn({
      turnId: "turn-user", turnExecutionId: USER_EXECUTION_ID,
      sessionId: "mcode-thread-provider", threadId: "thread-provider", workspaceId: "workspace-provider", message: "hi", cwd: "/tmp",
      model: "claude-sonnet-4-6", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { events: [...events], open };
  } finally {
    await provider.shutdown();
  }
}

function afterUserTurn(events: ProviderRuntimeEvent[]): ProviderRuntimeEvent[] {
  const userEnded = events.findIndex(({ event }) => event.type === AgentEventType.Ended && event.turnExecutionId === USER_EXECUTION_ID);
  return events.slice(userEnded + 1);
}

describe("ClaudeProvider provider-started turns", () => {
  it("opens a server turn for a self-started reply and routes it there", async () => {
    const { events, open } = await runBackgroundTask({
      kind: "opened",
      routing: { threadId: "thread-provider", turnId: "turn-provider", executionId: PROVIDER_EXECUTION_ID, deliveryAttempt: 1 },
    });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ threadId: "thread-provider", notice: SUMMARY });
    const later = afterUserTurn(events);
    expect(later.map(({ event }) => event.turnExecutionId)).toEqual(later.map(() => PROVIDER_EXECUTION_ID));
    expect(later.map(({ event }) => event.type)).toEqual(expect.arrayContaining([
      AgentEventType.TurnStarted, AgentEventType.Message, AgentEventType.TurnComplete,
    ]));
    expect(later.filter(({ event }) => event.type === AgentEventType.Ended)).toHaveLength(1);
    expect(later.at(-1)?.event.type).toBe(AgentEventType.Ended);
  });

  it("publishes nothing for a self-started reply the server declines", async () => {
    const { events, open } = await runBackgroundTask({ kind: "declined", reason: "busy" });

    expect(open).toHaveBeenCalledTimes(1);
    expect(afterUserTurn(events)).toEqual([]);
  });
});
