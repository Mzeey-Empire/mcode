import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import {
  ClaudeEventMapper,
  type ClaudeEventEvidence,
  type ClaudeEventMapperCallbacks,
} from "../claude-event-mapper.js";

function createMapper(captureSdkSessionId = vi.fn(() => true)) {
  const events: AgentEvent[] = [];
  const evidence: ClaudeEventEvidence[] = [];
  const callbacks: ClaudeEventMapperCallbacks = {
    emit: (event, source) => { events.push(event); evidence.push(source); },
    getSession: () => undefined,
    captureSdkSessionId,
    observeNativeGoalCommands: vi.fn(),
    applyNativeGoalCommandResult: vi.fn(),
    invalidateSdkSession: vi.fn(),
    markSessionPoisoned: vi.fn(),
    updateUsage: vi.fn(() => ({})),
    invalidateUsage: vi.fn(),
    resolveBillingMode: vi.fn(async () => "unknown"),
    isSessionStartHookSuppressed: vi.fn(() => false),
    clearSessionStartHookSuppression: vi.fn(),
  };
  return {
    events,
    evidence,
    captureSdkSessionId,
    mapper: new ClaudeEventMapper("mcode-test", "test", callbacks),
  };
}

describe("ClaudeEventMapper native dispatch", () => {
  it("captures first-init session metadata with its own root and replay identity", () => {
    const { mapper, evidence } = createMapper();
    mapper.captureSessionIdentity({ type: "system", subtype: "init", session_id: "SESSION_1", parent_tool_use_id: null, uuid: "INIT_1" }, true);
    expect(evidence).toEqual([{ parent: { kind: "root" }, sourceIdentities: [], nativeEventId: "INIT_1" }]);
  });

  it("does not reuse a previous envelope's parent or replay identity for session metadata", async () => {
    const { mapper, evidence } = createMapper();
    await mapper.map({ type: "system", subtype: "fixture", parent_tool_use_id: "PARENT_1", uuid: "PREVIOUS_1" });
    mapper.captureSessionIdentity({ type: "system", subtype: "init", session_id: "SESSION_1", uuid: "INIT_1" }, true);
    expect(evidence.at(-1)).toEqual({ parent: { kind: "absent" }, sourceIdentities: [], nativeEventId: "INIT_1" });
  });

  it("rejects conflicting native parents until the execution evidence is reset", async () => {
    const { mapper, evidence } = createMapper();
    const message = { type: "assistant", parent_tool_use_id: "PARENT_1", message: { content: [{ type: "tool_use", id: "TOOL_1", name: "Read", input: {} }] } };
    await mapper.map(message);
    await expect(mapper.map({ ...message, parent_tool_use_id: "PARENT_2" })).rejects.toThrow("Conflicting Claude native parent");
    await expect(mapper.map({ ...message, parent_tool_use_id: " " })).rejects.toThrow("Invalid Claude native parent");
    mapper.resetExecution();
    await mapper.map({ ...message, parent_tool_use_id: "PARENT_2" });
    expect(evidence.at(-1)?.parent).toEqual({ kind: "native", id: "PARENT_2" });
  });

  it.each(["__proto__", "constructor", "toString"])(
    "ignores unsafe native type %s",
    async (type) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type })).resolves.toBe("none");

      expect(events).toEqual([]);
    },
  );

  it.each(["__proto__", "constructor", "toString"])(
    "treats unsafe system subtype %s as an unknown native event",
    async (subtype) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type: "system", subtype })).resolves.toBe(
        "none",
      );

      expect(events).toEqual([
        {
          type: AgentEventType.System,
          threadId: "test",
          subtype,
        },
      ]);
    },
  );

  it("rejects a whitespace SDK session identity", () => {
    const { events, captureSdkSessionId, mapper } = createMapper();

    mapper.captureSessionIdentity({ type: "system", session_id: " \t " }, true);

    expect(captureSdkSessionId).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("ends a successful result with turnComplete so the writer accepts every event", async () => {
    const { events, mapper } = createMapper();

    await expect(mapper.map({ type: "result", is_error: false, result: "pong", usage: { output_tokens: 1 } }))
      .resolves.toBe("turn_complete");

    expect(events.map((event) => event.type)).toEqual([AgentEventType.QuotaUpdate, AgentEventType.TurnComplete]);
  });
});
