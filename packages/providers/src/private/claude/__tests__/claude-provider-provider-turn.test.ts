import { describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import type { ProviderTurnOpening } from "@mcode/providers";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeProvider, stubEnvService, stubJobObject } from "./helpers/provider-fixture.js";
import { mockShutdownHost } from "./helpers/mock-shutdown-host.js";

const USER_EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const PROVIDER_EXECUTION_ID = "66666666-6666-4666-8666-666666666666";
const SUMMARY = "Background command \"sleep 20\" completed";
const CONTINUATION_NOTICE = "Claude continued after a background task finished";

/** Replays the measured SDK sequence: a user turn, then a self-started turn after a background task finishes. */
function backgroundTaskQuery(notifyBeforeEnd: boolean) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closeSession!: () => void;
    const closed = new Promise<void>((resolve) => { closeSession = resolve; });
    const stream = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      const notification = { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", summary: SUMMARY };
      if (notifyBeforeEnd) yield notification;
      yield { type: "result", is_error: false, result: "started", usage: { output_tokens: 1 } };
      if (!notifyBeforeEnd) yield notification;
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "The background task finished." }] } };
      yield { type: "result", is_error: false, result: "The background task finished.", usage: { output_tokens: 6 } };
      await closed;
    })();
    return Object.assign(stream, { close: closeSession });
  };
}

const AGENT_SUMMARY = "Survey finished: auth.ts owns the bug";

/** Replays an Agent launched with run_in_background whose task notification lands after its turn ends. */
function backgroundAgentQuery(notify: boolean) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closeSession!: () => void;
    const closed = new Promise<void>((resolve) => { closeSession = resolve; });
    const stream = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [
        { type: "tool_use", id: "AGENT_1", name: "Agent", input: { description: "Survey", run_in_background: true } },
      ] } };
      yield { type: "system", subtype: "task_started", task_id: "task-agent", tool_use_id: "AGENT_1", is_backgrounded: true, task_type: "local_agent" };
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { status: "async_launched", isAsync: true, agentId: "agent-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "AGENT_1", content: "Async agent launched successfully." }] } };
      yield { type: "result", is_error: false, result: "launched", usage: { output_tokens: 1 } };
      if (notify) yield { type: "system", subtype: "task_notification", task_id: "task-agent", tool_use_id: "AGENT_1", status: "completed", summary: AGENT_SUMMARY };
      await closed;
    })();
    return Object.assign(stream, { close: closeSession });
  };
}

const WAKE_REPLY = "The subagent printed 42.";

/**
 * Replays live run 4: the background subagent streams right after its launch ends,
 * then Claude replies to the task notification in a turn it starts by itself.
 */
function backgroundAgentWakeQuery(beforeRootReply = () => {}) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closeSession!: () => void;
    const closed = new Promise<void>((resolve) => { closeSession = resolve; });
    const stream = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [
        { type: "tool_use", id: "AGENT_1", name: "Agent", input: { description: "Count", run_in_background: true } },
      ] } };
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { status: "async_launched", isAsync: true, agentId: "agent-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "AGENT_1", content: "Async agent launched successfully." }] } };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Launched." }] } };
      yield { type: "result", is_error: false, result: "Launched.", usage: { output_tokens: 1 } };
      yield { type: "assistant", parent_tool_use_id: "AGENT_1", message: { content: [
        { type: "tool_use", id: "BASH_1", name: "Bash", input: { command: "node -e \"console.log(42)\"" } },
      ] } };
      yield { type: "user", parent_tool_use_id: "AGENT_1", message: { content: [{ type: "tool_result", tool_use_id: "BASH_1", content: "42" }] } };
      yield { type: "system", subtype: "task_notification", task_id: "task-agent", tool_use_id: "AGENT_1", status: "completed", summary: AGENT_SUMMARY };
      yield { type: "assistant", parent_tool_use_id: "AGENT_1", message: { stop_reason: "end_turn", content: [{ type: "text", text: "## Subagent report\n- 42" }] } };
      beforeRootReply();
      yield { type: "system", subtype: "init", session_id: "sdk-provider-turn" };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: WAKE_REPLY }] } };
      yield { type: "result", is_error: false, result: WAKE_REPLY, usage: { output_tokens: 6 } };
      await closed;
    })();
    return Object.assign(stream, { close: closeSession });
  };
}

function sendUserTurn(provider: InstanceType<typeof ClaudeProvider>) {
  return provider.sendTurn({
    turnId: "turn-user", turnExecutionId: USER_EXECUTION_ID,
    sessionId: "mcode-thread-provider", threadId: "thread-provider", workspaceId: "workspace-provider", message: "hi", cwd: "/tmp",
    model: "claude-sonnet-4-6", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
  });
}

function providerWith(events: ProviderRuntimeEvent[], turns: Parameters<typeof mockShutdownHost>[1]) {
  return new ClaudeProvider(
    stubEnvService(), stubJobObject(), undefined, undefined, undefined,
    mockShutdownHost((event) => events.push(event), turns),
  );
}

async function runBackgroundTask(opening: ProviderTurnOpening, notifyBeforeEnd = false) {
  mockQuery.mockImplementation(backgroundTaskQuery(notifyBeforeEnd));
  const events: ProviderRuntimeEvent[] = [];
  const open = vi.fn(async () => opening);
  const provider = providerWith(events, { open, settleBackgroundTool: async () => {} });
  try {
    await sendUserTurn(provider);
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
  it.each([false, true])("opens a server turn with its wake reason when the task notifies before the result: %s", async (notifyBeforeEnd) => {
    const { events, open } = await runBackgroundTask({
      kind: "opened",
      routing: { threadId: "thread-provider", turnId: "turn-provider", executionId: PROVIDER_EXECUTION_ID, deliveryAttempt: 1 },
    }, notifyBeforeEnd);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ threadId: "thread-provider", notice: CONTINUATION_NOTICE });
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

describe("ClaudeProvider background agents", () => {
  const userEnded = (events: ProviderRuntimeEvent[]) =>
    events.some(({ event }) => event.type === AgentEventType.Ended && event.turnExecutionId === USER_EXECUTION_ID);
  const agentResults = (events: ProviderRuntimeEvent[]) =>
    events.filter(({ event }) => event.type === AgentEventType.ToolResult && event.toolCallId === "AGENT_1");

  it("holds the launch open and hands its later result to the launching turn", async () => {
    mockQuery.mockImplementation(backgroundAgentQuery(true));
    const events: ProviderRuntimeEvent[] = [];
    const settleBackgroundTool = vi.fn(async () => {});
    const provider = providerWith(events, { open: vi.fn(async (): Promise<ProviderTurnOpening> => ({ kind: "declined", reason: "busy" })), settleBackgroundTool });
    try {
      await sendUserTurn(provider);
      await vi.waitFor(() => expect(settleBackgroundTool).toHaveBeenCalled());
      expect(settleBackgroundTool).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-provider", executionId: USER_EXECUTION_ID,
        toolCallId: "AGENT_1", status: "completed", output: AGENT_SUMMARY });
      expect(events.find(({ event }) => event.type === AgentEventType.ToolBackgrounded)?.event)
        .toMatchObject({ toolCallId: "AGENT_1", turnExecutionId: USER_EXECUTION_ID });
      expect(agentResults(events)).toEqual([]);
    } finally {
      await provider.shutdown();
    }
    expect(settleBackgroundTool).toHaveBeenCalledTimes(1);
  });

  it("opens the wake turn at the reply, not at the subagent steps streamed after the launch ends", async () => {
    let rootReplyReady = false;
    const openedAtRootReply: boolean[] = [];
    mockQuery.mockImplementation(backgroundAgentWakeQuery(() => { rootReplyReady = true; }));
    const events: ProviderRuntimeEvent[] = [];
    const open = vi.fn(async (): Promise<ProviderTurnOpening> => {
      openedAtRootReply.push(rootReplyReady);
      return {
        kind: "opened",
        routing: { threadId: "thread-provider", turnId: "turn-provider", executionId: PROVIDER_EXECUTION_ID, deliveryAttempt: 1 },
      };
    });
    const provider = providerWith(events, { open, settleBackgroundTool: vi.fn(async () => {}) });
    try {
      await sendUserTurn(provider);
      await vi.waitFor(() => expect(events.some(({ event }) =>
        event.type === AgentEventType.Ended && event.turnExecutionId === PROVIDER_EXECUTION_ID)).toBe(true));
    } finally {
      await provider.shutdown();
    }

    expect(openedAtRootReply).toEqual([true]);
    expect(open).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-provider", notice: CONTINUATION_NOTICE });
    const wake = afterUserTurn(events);
    expect(wake.map(({ event }) => event.turnExecutionId)).toEqual(wake.map(() => PROVIDER_EXECUTION_ID));
    expect(wake.find(({ event }) => event.type === AgentEventType.Message)?.event).toMatchObject({ content: WAKE_REPLY });
    expect(events.filter(({ event }) => "toolCallId" in event && event.toolCallId === "BASH_1")).toEqual([]);
  });

  it("keeps the session busy while the call runs and stops it when the session shuts down", async () => {
    mockQuery.mockImplementation(backgroundAgentQuery(false));
    const events: ProviderRuntimeEvent[] = [];
    const settleBackgroundTool = vi.fn(async () => {});
    const provider = providerWith(events, { open: vi.fn(async (): Promise<ProviderTurnOpening> => ({ kind: "declined", reason: "busy" })), settleBackgroundTool });
    const spawn = vi.spyOn(provider, "spawn");
    await sendUserTurn(provider);
    await vi.waitFor(() => expect(userEnded(events)).toBe(true));
    const spawned = spawn.mock.results[0];
    if (spawned?.type !== "return") throw new Error("Expected the turn to spawn a session");
    expect(provider.isBusy((await spawned.value).state)).toBe(true);
    await provider.shutdown();
    await vi.waitFor(() => expect(settleBackgroundTool).toHaveBeenCalled());
    expect(settleBackgroundTool).toHaveBeenCalledExactlyOnceWith({ threadId: "thread-provider", executionId: USER_EXECUTION_ID,
      toolCallId: "AGENT_1", status: "cancelled", output: "Stopped when the Claude session ended." });
    expect(agentResults(events)).toEqual([]);
  });
});
