import { AgentEventSchema, type AgentEvent } from "@mcode/contracts";
import { describe, expect, it } from "vitest";

import { OtherProviderLiveEventEffects } from "../provider-live-event-effects.js";

const execution = {
  threadId: "provider-thread",
  turnId: "provider-turn",
  executionId: "11111111-1111-4111-8111-111111111111",
};

function event(type: AgentEvent["type"], fields: Record<string, unknown> = {}): AgentEvent {
  return AgentEventSchema().parse({ type, threadId: execution.threadId,
    turnExecutionId: execution.executionId, ...fields });
}

describe("OtherProviderLiveEventEffects", () => {
  it("prepares Claude text, assistant message, cursor, and terminal writes for one execution", () => {
    const owner = new OtherProviderLiveEventEffects("claude", execution, "user-message");
    const start = owner.prepare(event("turnStarted"));
    expect(start).toMatchObject({ kind: "prepared", providerId: "claude", execution,
      runtime: [{ kind: "turn-started" }] });

    const cursor = owner.prepare(event("system", { subtype: "sdk_session_id:claude-session" }));
    expect(cursor).toMatchObject({ kind: "prepared", effects: {
      systemIntents: [{ kind: "session-cursor", event: { subtype: "sdk_session_id:claude-session" } }],
    } });

    const delta = owner.prepare(event("textDelta", { delta: "Answer" }));
    expect(delta).toMatchObject({ kind: "prepared", effects: {
      text: { kind: "append", inputs: [{ ...execution, sequence: 1, text: "Answer" }] },
    } });
    expect(owner.prepare(event("assistantMessageBoundary", { isFinalResponse: true }))).toMatchObject({
      kind: "prepared", publication: { after: "writer" },
    });
    const message = owner.prepare(event("message", { content: "Answer", tokens: null }));
    expect(message).toMatchObject({ kind: "prepared", effects: {
      message: { content: "Answer", precedingMessageId: "user-message" },
    }, runtime: [{ kind: "assistant-message-feature", providerId: "claude",
      event: { type: "message", content: "Answer" } }] });
    const terminal = owner.prepare(event("turnComplete", {
      reason: "completed", costUsd: null, tokensIn: 4, tokensOut: 2,
    }), "2026-09-25T00:00:00.000Z");
    expect(terminal).toMatchObject({ kind: "prepared", publication: { after: "terminal" },
      terminal: { threadId: execution.threadId, executionId: execution.executionId,
        outcome: "completed", endedAt: "2026-09-25T00:00:00.000Z",
        assistant: { content: "Answer" } } });
    expect(structuredClone(terminal)).toEqual(terminal);
    expect(owner.prepare(event("hookStarted", { hookName: "stop", hookType: "stop" })))
      .toMatchObject({ kind: "prepared", publication: { after: "terminal" },
        runtime: [{ kind: "hook-started", late: true }] });
    expect(owner.prepare(event("message", { content: "Goal achieved in 2s.", tokens: null })))
      .toMatchObject({ kind: "unsupported", reason: expect.stringContaining("goal receipt") });
  });

  it("prepares Cursor unknown text and its final message without a boundary", () => {
    const owner = new OtherProviderLiveEventEffects("cursor", execution, "user-message");
    expect(owner.prepare(event("turnStarted"))).toMatchObject({ kind: "prepared" });
    expect(owner.prepare(event("textDelta", { delta: "Working" }))).toMatchObject({
      kind: "prepared", effects: { text: { kind: "append" } },
    });
    expect(owner.prepare(event("message", { content: "Done", tokens: null }))).toMatchObject({
      kind: "prepared", effects: { message: { content: "Done" } },
      runtime: [{ kind: "assistant-message-feature", providerId: "cursor" }],
    });
    expect(owner.prepare(event("turnComplete", {
      reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0,
    }))).toMatchObject({ kind: "prepared", terminal: { outcome: "completed",
      assistant: { content: "Done" } } });
  });

  it("rejects an unbound or stale event without advancing the owner", () => {
    const owner = new OtherProviderLiveEventEffects("claude", execution, "user-message");
    expect(owner.prepare(event("turnStarted", { turnExecutionId: undefined }))).toMatchObject({
      kind: "unsupported", reason: expect.stringContaining("without execution identity"),
    });
    expect(owner.prepare(event("turnStarted", {
      turnExecutionId: "22222222-2222-4222-8222-222222222222",
    }))).toMatchObject({
      kind: "unsupported", reason: "different execution",
    });
    expect(owner.prepare(event("turnStarted"))).toMatchObject({ kind: "prepared" });
    expect(owner.prepare(event("turnComplete", {
      reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "codex",
    }))).toMatchObject({ kind: "unsupported", reason: "different provider" });
    expect(owner.prepare(event("turnComplete", {
      reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0, providerId: "claude",
    }))).toMatchObject({ kind: "prepared", terminal: { outcome: "completed" } });
  });
});
