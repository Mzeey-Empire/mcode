import { describe, it, expect } from "vitest";
import { AgentEventSchema, AgentEventType } from "../agent-event.js";
import { ProviderRuntimeEventSchema } from "../provider-runtime-event.js";

describe("child-thread runtime boundary", () => {
  const extension = { providerId: "copilot", kind: "child-thread",
    childThread: { role: "child", path: ["task-1"], nativeItemId: "message-1" } };
  const event = { type: "textDelta", threadId: "parent", delta: "private child text" };

  it("preserves private routing evidence outside the renderer event", () => {
    expect(ProviderRuntimeEventSchema().parse({ event, extension })).toEqual({ event, extension });
    expect(AgentEventSchema().safeParse({ ...event, childThread: extension.childThread }).success).toBe(false);
  });

  it("rejects child text without identity and invalid ancestry", () => {
    for (const childThread of [
      { role: "child", path: ["task-1"] },
      { ...extension.childThread, path: [] },
      { ...extension.childThread, path: Array(9).fill("task-1") },
    ]) {
      expect(ProviderRuntimeEventSchema().safeParse({ event, extension: { ...extension, childThread } }).success).toBe(false);
    }
  });

  it("requires a delegate to match its Agent tool and rejects nested-step evidence", () => {
    const delegate = { ...extension, childThread: { role: "delegate", path: ["task-1"], prompt: "Investigate" } };
    const tool = { type: "toolUse", threadId: "parent", toolName: "Agent", toolCallId: "task-1", toolInput: {} };
    expect(ProviderRuntimeEventSchema().parse({ event: tool, extension: delegate })).toEqual({ event: tool, extension: delegate });
    for (const invalid of [{ ...tool, toolCallId: "other" }, { ...tool, toolName: "Read" }, event]) {
      expect(ProviderRuntimeEventSchema().safeParse({ event: invalid, extension: delegate }).success).toBe(false);
    }
    expect(ProviderRuntimeEventSchema().safeParse({ event: { ...tool, parentToolCallId: "outer" }, extension }).success).toBe(false);
    expect(ProviderRuntimeEventSchema().safeParse({ event: tool,
      extension: { ...extension, childThread: { ...extension.childThread, final: true } } }).success).toBe(false);
    expect(ProviderRuntimeEventSchema().safeParse({ event: { type: "reasoningDelta", threadId: "parent", delta: "hidden" }, extension }).success).toBe(false);
  });
});

describe("AgentEvent provider_unavailable", () => {
  it("preserves a bounded durable publication identity", () => {
    const event = { type: "turnStarted", threadId: "t-1",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      publicationId: "1" };
    expect(AgentEventSchema().parse(event)).toEqual(event);
    expect(AgentEventSchema().safeParse({ ...event, publicationId: "x" }).success).toBe(false);
    expect(AgentEventSchema().safeParse({ ...event, publicationId: "1".repeat(17) }).success)
      .toBe(false);
  });

  it("parses a disabled-provider event", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "codex",
      reason: "disabled",
    });
    expect(parsed.type).toBe(AgentEventType.ProviderUnavailable);
  });

  it("parses a cli_missing event with configuredPath", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "claude",
      reason: "cli_missing",
      configuredPath: "/custom/claude",
    });
    if (parsed.type !== "providerUnavailable") throw new Error("unreachable");
    expect(parsed.configuredPath).toBe("/custom/claude");
  });
});

describe("AgentEvent generated attachments", () => {
  const attachment = {
    id: "img-1",
    name: "generated.png",
    mimeType: "image/png",
    sizeBytes: 128,
  };

  it("parses a generatedAttachment event", () => {
    const parsed = AgentEventSchema().parse({
      type: "generatedAttachment",
      threadId: "t-1",
      attachment,
    });
    expect(parsed.type).toBe(AgentEventType.GeneratedAttachment);
  });

  it("parses assistant message attachments", () => {
    const parsed = AgentEventSchema().parse({
      type: "message",
      threadId: "t-1",
      content: "",
      tokens: null,
      attachments: [attachment],
    });
    if (parsed.type !== "message") throw new Error("unreachable");
    expect(parsed.attachments).toEqual([attachment]);
  });
});

describe("AgentEvent ended outcome", () => {
  it("parses a terminal Ended outcome", () => {
    const parsed = AgentEventSchema().parse({
      type: "ended",
      threadId: "t-1",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      outcome: "errored",
      reason: "codex_idle_timeout",
    });

    expect(parsed.type).toBe(AgentEventType.Ended);
    if (parsed.type !== AgentEventType.Ended) throw new Error("unreachable");
    expect(parsed.outcome).toBe("errored");
  });

  it.each(["completed", "cancelled", "interrupted", "errored"] as const)(
    "accepts the shared %s terminal outcome",
    (outcome) => {
      const parsed = AgentEventSchema().parse({
        type: "ended",
        threadId: "t-1",
        turnExecutionId: "00000000-0000-4000-8000-000000000001",
        outcome,
      });

      expect(parsed.type).toBe(AgentEventType.Ended);
      if (parsed.type !== AgentEventType.Ended) throw new Error("unreachable");
      expect(parsed.outcome).toBe(outcome);
    },
  );

  it("rejects an Ended event without execution identity", () => {
    expect(() => AgentEventSchema().parse({
      type: "ended",
      threadId: "t-1",
      outcome: "interrupted",
    })).toThrow();
  });
});

describe("AgentEvent error failure", () => {
  it("parses an Error with a classified failure", () => {
    const parsed = AgentEventSchema().parse({
      type: "error",
      threadId: "t-1",
      error: "529 Overloaded",
      failure: { kind: "retryable", status: 529, retryAfterMs: 8_000, retries: { made: 3, max: 10 } },
    });

    if (parsed.type !== AgentEventType.Error) throw new Error("unreachable");
    expect(parsed.failure).toEqual({ kind: "retryable", status: 529, retryAfterMs: 8_000, retries: { made: 3, max: 10 } });
  });

  it("rejects an Error without failure", () => {
    const result = AgentEventSchema().safeParse({ type: "error", threadId: "t-1", error: "boom" });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown failure kind and an out-of-range status", () => {
    const base = { type: "error", threadId: "t-1", error: "boom" };

    expect(AgentEventSchema().safeParse({ ...base, failure: { kind: "transient" } }).success).toBe(false);
    expect(AgentEventSchema().safeParse({ ...base, failure: { kind: "fatal", status: 600 } }).success).toBe(false);
  });
});

describe("AgentEvent MCP startup status", () => {
  it("parses Codex MCP startup status payloads", () => {
    const parsed = AgentEventSchema().parse({
      type: AgentEventType.McpServerStartupStatus,
      threadId: "thread-1",
      providerId: "codex",
      serverThreadId: "codex-thread-1",
      name: "figma-dev-mode",
      status: "failed",
      error: "connection refused",
      failureReason: "optional server unavailable",
    });

    expect(parsed.type).toBe(AgentEventType.McpServerStartupStatus);
    if (parsed.type !== AgentEventType.McpServerStartupStatus) throw new Error("unreachable");
    expect(parsed.name).toBe("figma-dev-mode");
    expect(parsed.status).toBe("failed");
  });
});

describe("AgentEvent reasoning delta", () => {
  it("parses a reasoning block chunk and its empty-text end", () => {
    const chunk = { type: "reasoningDelta", threadId: "t-1", delta: "Checking", reasoningItemId: "rs_1" };
    const end = { type: "reasoningDelta", threadId: "t-1", delta: "", reasoningItemId: "rs_1", done: true };
    expect(AgentEventSchema().parse(chunk)).toEqual(chunk);
    expect(AgentEventSchema().parse(end)).toEqual(end);
  });

  it("rejects an oversized delta and an empty block id", () => {
    const base = { type: "reasoningDelta", threadId: "t-1" };
    expect(AgentEventSchema().safeParse({ ...base, delta: "x".repeat(65_537) }).success).toBe(false);
    expect(AgentEventSchema().safeParse({ ...base, delta: "x", reasoningItemId: "" }).success).toBe(false);
    expect(AgentEventSchema().safeParse({ ...base, delta: "x".repeat(65_536) }).success).toBe(true);
  });
});
