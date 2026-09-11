import { describe, expect, it } from "vitest";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";

const first = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 };
const second = { totalTokens: 180, inputTokens: 150, cachedInputTokens: 80, outputTokens: 30, reasoningOutputTokens: 10 };

function start(mapper: CodexEventMapper, id: string) {
  mapper.prepareForTurn();
  mapper.mapNotification({ method: "turn/started", params: { threadId: "native-main", turn: { id } } });
}

function update(mapper: CodexEventMapper, turnId: string, total = first, last = first, threadId = "native-main") {
  return mapper.mapNotificationWithDisposition({ method: "thread/tokenUsage/updated", params: {
    threadId, turnId, tokenUsage: { total, last, modelContextWindow: 200_000 },
  } });
}

function complete(mapper: CodexEventMapper, id: string) {
  return mapper.mapNotification({ method: "turn/completed", params: {
    threadId: "native-main", turn: { id, status: "completed", items: [], error: null },
  } }).find(({ event }) => event.type === "turnComplete")?.event;
}

describe("native Codex token usage", () => {
  it("ignores a previous turn's completion without clearing the active turn", () => {
    const mapper = new CodexEventMapper("thread-1", "native-main");
    start(mapper, "old");
    complete(mapper, "old");
    start(mapper, "new");
    update(mapper, "new");
    expect(complete(mapper, "old")).toBeUndefined();
    expect(complete(mapper, "new")).toMatchObject({ tokensIn: 100, tokensOut: 20, totalProcessedTokens: 120 });
  });

  it.each(["failed", "interrupted"])("publishes usage without successful completion when a turn is %s", (status) => {
    const mapper = new CodexEventMapper("thread-1", "native-main");
    start(mapper, "turn-1");
    const usageEvents = update(mapper, "turn-1").events.map(({ event }) => event);
    expect(usageEvents).toEqual([{
      type: "contextEstimate", threadId: "thread-1", tokensIn: 100, tokensOut: 20,
      totalProcessedTokens: 120, cacheReadTokens: 40, contextWindow: 200_000,
    }]);
    const terminal = mapper.mapNotification({ method: "turn/completed", params: {
      threadId: "native-main", turn: { id: "turn-1", status, items: [], error: status === "failed" ? { message: "failure" } : null },
    } });
    expect(terminal.map(({ event }) => event.type)).toEqual(status === "failed" ? ["error"] : []);
  });

  it("reports context and all requests in a turn without double-counting cached tokens or duplicate updates", () => {
    const mapper = new CodexEventMapper("thread-1", "native-main");
    start(mapper, "turn-1");
    expect(update(mapper, "turn-1").events.map(({ event }) => event.type)).toEqual(["contextEstimate"]);
    const total = { totalTokens: 300, inputTokens: 250, cachedInputTokens: 120, outputTokens: 50, reasoningOutputTokens: 15 };
    update(mapper, "turn-1", total, second);
    update(mapper, "turn-1", total, second);
    expect(complete(mapper, "turn-1")).toEqual({
      type: "turnComplete", threadId: "thread-1", reason: "end_turn", costUsd: null,
      tokensIn: 150, tokensOut: 50, totalProcessedTokens: 300,
      cacheReadTokens: 120, contextWindow: 200_000, providerId: "codex",
    });
  });

  it("excludes previous turns on resume and clears usage before the next turn", () => {
    const mapper = new CodexEventMapper("thread-1", "native-main");
    start(mapper, "turn-2");
    update(mapper, "turn-2", { totalTokens: 300, inputTokens: 250, cachedInputTokens: 120, outputTokens: 50, reasoningOutputTokens: 15 }, second);
    expect(complete(mapper, "turn-2")).toMatchObject({ tokensIn: 150, tokensOut: 30, totalProcessedTokens: 180, cacheReadTokens: 80 });
    start(mapper, "turn-3");
    update(mapper, "turn-2");
    update(mapper, "turn-3", first, first, "foreign-thread");
    expect(complete(mapper, "turn-3")).toMatchObject({ tokensIn: 0, tokensOut: 0, totalProcessedTokens: 0 });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid token counts (%s) before state changes", (inputTokens) => {
    const mapper = new CodexEventMapper("thread-1", "native-main");
    start(mapper, "turn-1");
    expect(update(mapper, "turn-1", { ...first, inputTokens }).disposition).toEqual({ kind: "diagnostic", reason: "malformed-notification" });
    expect(complete(mapper, "turn-1")).toMatchObject({ tokensIn: 0, tokensOut: 0, totalProcessedTokens: 0 });
  });
});
