import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcode/shared")>()),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "./helpers/provider-fixture.js";
import { stubEnvService } from "./helpers/provider-fixture.js";
import { stubJobObject } from "./helpers/provider-fixture.js";
import { mockProviderHost, queryMethodStubs } from "./helpers/mock-sdk-query.js";

function sdkStream(messages: Array<Record<string, unknown>>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const prompts = prompt[Symbol.asyncIterator]();
    let index = 0;
    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (index++ === 0) await prompts.next();
        return index <= messages.length
          ? { value: messages[index - 1]!, done: false }
          : { value: undefined as never, done: true };
      },
      async return() {
        return { value: undefined as never, done: true };
      },
      async throw(error: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(generator, { ...queryMethodStubs(), close: vi.fn() });
  };
}

function failingStream(message: string) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const prompts = prompt[Symbol.asyncIterator]();
    let initialized = false;
    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (!initialized) {
          initialized = true;
          await prompts.next();
          return {
            value: {
              type: "system",
              subtype: "init",
              session_id: "sdk-stream",
            },
            done: false,
          };
        }
        throw new Error(message);
      },
      async return() {
        return { value: undefined as never, done: true };
      },
      async throw(error: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(generator, { ...queryMethodStubs(), close: vi.fn() });
  };
}

const FIRST_SEGMENT = [
  { type: "system", subtype: "init", session_id: "sdk-steer" },
  { type: "assistant", message: { content: [{ type: "text", text: "one two" }] } },
];
const STEER_ID = "61c88901-8d40-407e-bdd3-984aa0cba6ab";

/**
 * Plays the first segment, then waits for the next prompt before playing `afterSteer`. The
 * recorded result shapes come from a live SDK 0.3.291 run with `priority: "now"`. `holdOpen`
 * keeps the query open until its prompts close, as a warm session does.
 */
function steeredStream(afterSteer: Array<Record<string, unknown>>, { holdOpen = false } = {}) {
  let steerRead: (message: unknown) => void = () => undefined;
  const steered = new Promise<unknown>((resolve) => { steerRead = resolve; });
  let segmentPlayed: () => void = () => undefined;
  const awaitingSteer = new Promise<void>((resolve) => { segmentPlayed = resolve; });
  const factory = ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const prompts = prompt[Symbol.asyncIterator]();
    async function* play(): AsyncGenerator<Record<string, unknown>, void> {
      await prompts.next();
      yield* FIRST_SEGMENT;
      segmentPlayed();
      steerRead((await prompts.next()).value);
      yield* afterSteer;
      if (holdOpen) await prompts.next();
    }
    return Object.assign(play(), { ...queryMethodStubs(), close: vi.fn() });
  };
  return { factory, steered, awaitingSteer };
}

async function send(
  provider: ClaudeProvider,
  sessionId: string,
  events: readonly ProviderRuntimeEvent[],
  resumeFrom?: string,
): Promise<void> {
  await provider.sendTurn({
    turnExecutionId: "execution",
    sessionId,
    threadId: sessionId.slice(6),
    message: "go",
    cwd: "/tmp",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    interactionMode: "build",
    providerOptions: {},
    ...(resumeFrom ? { resumeFrom } : {}),
  });
  await vi.waitFor(() =>
    expect(events.filter(({ event }) => event.type === AgentEventType.Ended)).toHaveLength(1),
  );
}

describe("ClaudeProvider stream mapping", () => {
  let provider: ClaudeProvider | undefined;

  afterEach(() => provider?.shutdown());

  it("preserves parent_tool_use_id for assistant blocks and standalone tool messages", async () => {
    mockQuery.mockImplementation(
      sdkStream([
        { type: "system", subtype: "init", session_id: "sdk-parent" },
        {
          type: "assistant",
          parent_tool_use_id: "agent-one",
          message: {
            content: [
              { type: "tool_use", id: "child-one", name: "Read", input: {} },
            ],
          },
        },
        {
          type: "tool_use",
          parent_tool_use_id: "agent-two",
          id: "child-two",
          tool_name: "Bash",
          tool_input: {},
        },
        { type: "result", is_error: false, usage: {}, modelUsage: {} },
      ]),
    );
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await send(provider, "mcode-parent-ids", events);

    expect(
      events
        .filter((event) => event.event.type === AgentEventType.ToolUse)
        .map((event) => [event.event.toolCallId, event.event.parentToolCallId]),
    ).toEqual([
      ["child-one", "agent-one"],
      ["child-two", "agent-two"],
    ]);
  });

  it.each([
    "stream disconnected",
    "process exited with code 1",
    "stream timeout",
  ])("publishes Error before Ended after %s", async (failure) => {
    mockQuery.mockImplementation(failingStream(failure));
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await send(provider, `mcode-${failure.replaceAll(" ", "-")}`, events);

    const errorIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.Error,
    );
    const endedIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.Ended,
    );
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(endedIndex).toBeGreaterThan(errorIndex);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "keeps exactly one terminal sequence after unsafe native dispatch %s",
    async (unsafeValue) => {
      mockQuery.mockImplementation(
        sdkStream([
          { type: "system", subtype: "init", session_id: "sdk-safe" },
          { type: unsafeValue },
          { type: "system", subtype: unsafeValue },
          { type: "result", is_error: false, usage: {}, modelUsage: {} },
        ]),
      );
      const events: ProviderRuntimeEvent[] = [];
      provider = new ClaudeProvider(
        stubEnvService(),
        stubJobObject(),
        undefined,
        undefined,
        undefined,
        mockProviderHost((event) => events.push(event)),
      );

      await send(provider, `mcode-unsafe-${unsafeValue}`, events);

      expect(
        events.filter((event) => event.event.type === AgentEventType.Error),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.event.type === AgentEventType.TurnComplete),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.type === AgentEventType.Ended),
      ).toHaveLength(1);
    },
  );

  it("steers with priority now and keeps the turn open across the segment it cut short", async () => {
    const stream = steeredStream([
      { type: "result", subtype: "success", is_error: false, terminal_reason: "aborted_streaming",
        user_message_uuids: ["first-prompt"], usage: {}, modelUsage: {} },
      { type: "system", subtype: "status", user_message_uuids: [STEER_ID] },
      { type: "assistant", message: { content: [{ type: "text", text: "PINEAPPLE" }] } },
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuids: [STEER_ID], usage: {}, modelUsage: {} },
    ]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(outcome).toEqual({ outcome: "accepted" });
    expect(await stream.steered).toEqual({
      type: "user", message: { role: "user", content: "Reply with PINEAPPLE." }, parent_tool_use_id: null,
      session_id: sessionId, priority: "now", uuid: STEER_ID,
    });
    expect(events.flatMap(({ event }) => event.type === AgentEventType.Message ? [event.content] : []))
      .toEqual(["one two", "PINEAPPLE"]);
    expect(events.filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(1);
    expect(events.at(-1)?.event).toMatchObject({ type: AgentEventType.Ended, turnExecutionId: "execution" });
  });

  it("keeps the turn open when a segment completes before Claude took in a steer it read", async () => {
    const stream = steeredStream([
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuids: ["first-prompt"], usage: {}, modelUsage: {} },
      { type: "system", subtype: "status", user_message_uuids: [STEER_ID] },
      { type: "assistant", message: { content: [{ type: "text", text: "PINEAPPLE" }] } },
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuids: [STEER_ID], usage: {}, modelUsage: {} },
    ]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-completed";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer-completed", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(outcome).toEqual({ outcome: "accepted" });
    expect(events.flatMap(({ event }) => event.type === AgentEventType.Message ? [event.content] : []))
      .toEqual(["one two", "PINEAPPLE"]);
    expect(events.filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(1);
    expect(events.at(-1)?.event).toMatchObject({ type: AgentEventType.Ended, turnExecutionId: "execution" });
  });

  it("ends the turn at a completed result that names the steer it answered", async () => {
    const stream = steeredStream([
      { type: "assistant", message: { content: [{ type: "text", text: "PINEAPPLE" }] } },
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuids: ["first-prompt", STEER_ID], usage: {}, modelUsage: {} },
    ]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-joined";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    await provider.steerTurn({ sessionId, threadId: "steer-joined", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(events.filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(1);
  });

  it("accepts a steer an older CLI names only in user_message_uuid", async () => {
    const stream = steeredStream([
      { type: "result", subtype: "success", is_error: false, terminal_reason: "aborted_streaming",
        user_message_uuid: "first-prompt", usage: {}, modelUsage: {} },
      { type: "assistant", user_message_uuid: STEER_ID, message: { content: [{ type: "text", text: "PINEAPPLE" }] } },
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuid: STEER_ID, usage: {}, modelUsage: {} },
    ]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-singular";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer-singular", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(outcome).toEqual({ outcome: "accepted" });
    expect(events.flatMap(({ event }) => event.type === AgentEventType.Message ? [event.content] : []))
      .toEqual(["one two", "PINEAPPLE"]);
    expect(events.filter(({ event }) => event.type === AgentEventType.TurnComplete)).toHaveLength(1);
  });

  it("ends the turn when Claude goes idle without answering a steer it read, and reports it unknown", async () => {
    const stream = steeredStream([
      { type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
        user_message_uuids: ["first-prompt"], usage: {}, modelUsage: {} },
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ], { holdOpen: true });
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-idle";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer-idle", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(outcome).toEqual({ outcome: "unknown", detail: "Claude read the message but the turn ended before it answered." });
    expect(events.at(-1)?.event).toMatchObject({ type: AgentEventType.Ended, turnExecutionId: "execution" });
  });

  it("reports a read steer unknown when the stream closes before Claude answers it", async () => {
    const stream = steeredStream([
      { type: "result", subtype: "success", is_error: false, terminal_reason: "aborted_streaming",
        user_message_uuids: ["first-prompt"], usage: {}, modelUsage: {} },
    ]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-closed";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer-closed", turnExecutionId: "execution",
      steerId: STEER_ID, message: "Reply with PINEAPPLE." });
    await ended;

    expect(outcome).toEqual({ outcome: "unknown", detail: "Claude read the message but the turn ended before it answered." });
  });

  it("takes back a steer Claude does not read in time and reports it refused", async () => {
    let segmentPlayed: () => void = () => undefined;
    const awaitingSteer = new Promise<void>((resolve) => { segmentPlayed = resolve; });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reportNext: (next: IteratorResult<unknown>) => void = () => undefined;
    const nextPrompt = new Promise<IteratorResult<unknown>>((resolve) => { reportNext = resolve; });
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const prompts = prompt[Symbol.asyncIterator]();
      async function* play(): AsyncGenerator<Record<string, unknown>, void> {
        await prompts.next();
        yield* FIRST_SEGMENT;
        segmentPlayed();
        await released;
        reportNext(await prompts.next());
        yield { type: "result", subtype: "success", is_error: false, terminal_reason: "completed", usage: {}, modelUsage: {} };
      }
      return Object.assign(play(), { ...queryMethodStubs(), close: vi.fn() });
    });
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-unread";

    const ended = send(provider, sessionId, events);
    await awaitingSteer;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: unknown;
    try {
      const steering = provider.steerTurn({ sessionId, threadId: "steer-unread", turnExecutionId: "execution",
        steerId: STEER_ID, message: "late" });
      await vi.advanceTimersByTimeAsync(10_000);
      outcome = await steering;
    } finally {
      vi.useRealTimers();
    }
    release();
    void provider.stopSession(sessionId);

    expect(outcome).toEqual({ outcome: "rejected", reason: "provider", detail: "Claude did not read the message in time." });
    // The queue closed with nothing on it: the refused steer can no longer reach Claude.
    expect(await nextPrompt).toMatchObject({ done: true });
    await ended;
  });

  it("refuses a steer for an execution the stream is not running", async () => {
    const stream = steeredStream([{ type: "result", is_error: false, usage: {}, modelUsage: {} }]);
    mockQuery.mockImplementation(stream.factory);
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const sessionId = "mcode-steer-stale";

    const ended = send(provider, sessionId, events);
    await stream.awaitingSteer;
    const outcome = await provider.steerTurn({ sessionId, threadId: "steer-stale", turnExecutionId: "earlier",
      steerId: STEER_ID, message: "late" });

    expect(outcome).toEqual({ outcome: "rejected", reason: "turn_not_running", detail: "Claude is not running this turn." });
    await provider.stopSession(sessionId);
    await ended;
  });

  it("emits synthetic TurnStarted before the No conversation resume recovery", async () => {
    mockQuery
      .mockImplementationOnce(
        sdkStream([
          {
            type: "result",
            is_error: true,
            errors: ["No conversation found with session ID: previous-sdk"],
          },
        ]),
      )
      .mockImplementationOnce(
        sdkStream([
          { type: "system", subtype: "init", session_id: "fresh-sdk" },
          { type: "result", is_error: false, usage: {}, modelUsage: {} },
        ]),
      );
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const priorQueryCalls = mockQuery.mock.calls.length;

    await send(provider, "mcode-resume-order", events, "previous-sdk");
    await vi.waitFor(() =>
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(
        priorQueryCalls + 2,
      ),
    );

    const startedIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.TurnStarted,
    );
    const restartedIndex = events.findIndex(
      (event) =>
        event.event.type === AgentEventType.System &&
        event.event.subtype === "session_restarted",
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(restartedIndex).toBeGreaterThan(startedIndex);
  });
});
