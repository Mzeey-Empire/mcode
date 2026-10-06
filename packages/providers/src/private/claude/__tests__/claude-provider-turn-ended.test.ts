import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeProvider, stubEnvService, stubJobObject } from "./helpers/provider-fixture.js";
import { mockShutdownHost } from "./helpers/mock-shutdown-host.js";

const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

function warmSessionQuery(result: Record<string, unknown>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closeSession!: () => void;
    const closed = new Promise<void>((resolve) => { closeSession = resolve; });
    const stream = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sdk-turn-ended" };
      yield { type: "result", ...result };
      // The SDK keeps a warm session open until it is closed.
      await closed;
    })();
    return Object.assign(stream, { close: closeSession });
  };
}

async function eventsUntilEnded(result: Record<string, unknown>): Promise<ProviderRuntimeEvent[]> {
  mockQuery.mockImplementation(warmSessionQuery(result));
  const events: ProviderRuntimeEvent[] = [];
  let sawEnded!: () => void;
  const ended = new Promise<void>((resolve) => { sawEnded = resolve; });
  const provider = new ClaudeProvider(
    stubEnvService(), stubJobObject(), undefined, undefined, undefined,
    mockShutdownHost((event) => {
      events.push(event);
      if (event.event.type === AgentEventType.Ended) sawEnded();
    }),
  );
  try {
    await provider.sendTurn({
      turnId: "turn-ended", turnExecutionId: EXECUTION_ID,
      sessionId: "mcode-thread-ended", threadId: "thread-ended", workspaceId: "workspace-ended", message: "hi", cwd: "/tmp",
      model: "claude-sonnet-4-6", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
    });
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    return [...events];
  } finally {
    await provider.shutdown();
  }
}

function turnRequest(turnExecutionId: string) {
  return {
    turnId: `turn-${turnExecutionId}`, turnExecutionId,
    sessionId: "mcode-thread-ended", threadId: "thread-ended", workspaceId: "workspace-ended", message: "hi", cwd: "/tmp",
    model: "claude-sonnet-4-6", permissionMode: "supervised" as const, approvalReviewMode: "manual" as const,
    interactionMode: "build" as const, providerOptions: {},
  };
}

describe("ClaudeProvider turn end", () => {
  it("routes a follow-up turn's leading system message to the follow-up execution", async () => {
    const SECOND_EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const stream = (async function* () {
        let turn = 0;
        for await (const _input of prompt) {
          turn += 1;
          if (turn === 1) yield { type: "system", subtype: "init", session_id: "sdk-follow-up" };
          yield { type: "system", subtype: "fixture_notice" };
          yield { type: "result", is_error: false, result: "done", usage: { output_tokens: 1 } };
        }
      })();
      return Object.assign(stream, { close: vi.fn(() => { void stream.return(); }) });
    });
    const events: ProviderRuntimeEvent[] = [];
    const provider = new ClaudeProvider(
      stubEnvService(), stubJobObject(), undefined, undefined, undefined,
      mockShutdownHost((event) => events.push(event)),
    );
    const endedFor = (executionId: string) => events.some(({ event }) =>
      event.type === AgentEventType.Ended && event.turnExecutionId === executionId);
    try {
      await provider.sendTurn(turnRequest(EXECUTION_ID));
      await vi.waitFor(() => expect(endedFor(EXECUTION_ID)).toBe(true));
      await provider.sendTurn(turnRequest(SECOND_EXECUTION_ID));
      await vi.waitFor(() => expect(endedFor(SECOND_EXECUTION_ID)).toBe(true));

      const statuses = events.filter(({ event }) => event.type === AgentEventType.System && event.subtype === "fixture_notice");
      expect(statuses.map(({ event }) => event.turnExecutionId)).toEqual([EXECUTION_ID, SECOND_EXECUTION_ID]);
    } finally {
      await provider.shutdown();
    }
  });

  it("ends a completed turn while the SDK session stays open", async () => {
    const events = await eventsUntilEnded({ is_error: false, result: "done", usage: { output_tokens: 1 } });

    const types = events.map(({ event }) => event.type);
    expect(types.slice(types.indexOf(AgentEventType.TurnComplete))).toEqual([AgentEventType.TurnComplete, AgentEventType.Ended]);
    expect(events.at(-1)?.event).toMatchObject({ type: AgentEventType.Ended, turnExecutionId: EXECUTION_ID });
  });

  it("ends a failed turn while the SDK session stays open", async () => {
    const events = await eventsUntilEnded({ is_error: true, subtype: "success", result: "API Error: 400 unsupported model", errors: [] });

    const types = events.map(({ event }) => event.type);
    expect(types.slice(types.indexOf(AgentEventType.Error))).toEqual([AgentEventType.Error, AgentEventType.Ended]);
    expect(events.at(-1)?.event).toMatchObject({ type: AgentEventType.Ended, turnExecutionId: EXECUTION_ID });
  });
});
