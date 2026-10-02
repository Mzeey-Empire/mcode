import { AgentEventSchema, MessageSchema, type AgentEvent, type ProviderId } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { prepareAcceptedSystemObservation } from "../accepted-system-observation.js";

const execution = { threadId: "parent-thread", turnId: "parent-turn", executionId: "00000000-0000-4000-8000-000000000001" };
const acceptedAt = "2026-09-30T20:15:30.125+01:00";
const base = { operationId: "lease:observation:8", execution, providerId: "codex", messageSequence: 12, acceptedAt, compacting: false };

function event(payload: object): AgentEvent {
  return AgentEventSchema().parse({ ...execution, turnExecutionId: execution.executionId, ...payload });
}

function notice(message = "Provider warning"): Extract<AgentEvent, { type: "system" }> {
  return { threadId: execution.threadId, turnExecutionId: execution.executionId,
    type: "system", subtype: "provider.notice.warning", message, systemNotice: {
    kind: "warning", presentation: "timeline", scope: "turn", sessionId: "session-1", noticeKey: "warning-1",
  } };
}

function completion(): AgentEvent {
  return event({ type: "turnComplete", reason: "done", costUsd: null, tokensIn: 32_000, tokensOut: 40, contextWindow: 128_000 });
}

describe("prepareAcceptedSystemObservation", () => {
  it("assigns an operation-stable notice identity and exact supplied timestamp/sequence without mutating input", () => {
    const source = notice();
    const prepared = prepareAcceptedSystemObservation({ ...base, event: source });
    expect(prepared).toEqual(prepareAcceptedSystemObservation({ ...base, event: source }));
    expect(prepared.message).toMatchObject({
      thread_id: execution.threadId, role: "system", content: "Provider warning", sequence: 12,
      timestamp: acceptedAt, is_internal: false, systemNotice: { noticeKey: "warning-1", sessionId: "session-1" },
    });
    expect(MessageSchema().parse(prepared.message)).toEqual(prepared.message);
    expect(prepared.event).toEqual({ ...source, messageId: prepared.message?.id });
    expect(source).not.toHaveProperty("messageId");
    expect(prepared.event).toMatchObject({ threadId: execution.threadId, turnExecutionId: execution.executionId });
    expect(prepareAcceptedSystemObservation({ ...base, operationId: "lease:observation:9", event: source }).message?.id)
      .not.toBe(prepared.message?.id);
  });

  it("accepts its already-assigned notice identity and rejects conflicting provider assignment", () => {
    const prepared = prepareAcceptedSystemObservation({ ...base, event: notice() });
    expect(prepareAcceptedSystemObservation({ ...base, event: prepared.event })).toEqual(prepared);
    const conflict = event({ type: "system", subtype: "provider.notice.warning", message: "Warning", messageId: "00000000-0000-4000-8000-000000000099" });
    expect(() => prepareAcceptedSystemObservation({ ...base, event: conflict })).toThrow("conflicting message identity");
  });

  it("retains bounded configuration/security metadata, strips unrelated fields, and rejects malformed or raw runtime evidence", () => {
    const raw = { type: "system", threadId: execution.threadId, turnExecutionId: execution.executionId,
      subtype: "provider.notice.configuration", message: "<script>untrusted config</script>", providerSecret: "private",
      systemNotice: { kind: "configuration", presentation: "timeline", scope: "session", sessionId: "session-1",
        noticeKey: "config-1", origin: "unattributed-thread", configPath: "C:/workspace/config.toml",
        configRange: { startLine: 1, startColumn: 2, endLine: 3, endColumn: 4 } },
    } satisfies AgentEvent & { providerSecret: string };
    const prepared = prepareAcceptedSystemObservation({ ...base, event: raw });
    expect(prepared.message?.systemNotice).toEqual(raw.systemNotice);
    expect(prepared.message?.content).toBe(raw.message);
    expect(prepared.event).not.toHaveProperty("providerSecret");
    expect(prepared.message).not.toHaveProperty("providerSecret");
    raw.systemNotice.configRange.startLine = 99;
    expect(prepared.message?.systemNotice?.configRange?.startLine).toBe(1);
    const oversized = { ...raw, systemNotice: { ...raw.systemNotice, sessionId: "x".repeat(65) } };
    expect(() => prepareAcceptedSystemObservation({ ...base, event: oversized })).toThrow();
    const secretMetadata = { ...raw, systemNotice: { ...raw.systemNotice, nativeThreadId: "private" } };
    expect(() => prepareAcceptedSystemObservation({ ...base, event: secretMetadata })).toThrow();
    const runtimeEvidence = { ...raw, codexChild: { nativeThreadId: "private" } };
    expect(() => prepareAcceptedSystemObservation({ ...base, event: runtimeEvidence })).toThrow();
  });

  it("projects session selection only, including startup without a selected session, and leaves SDK cursors to their writer owner", () => {
    const startup = event({ type: "system", subtype: "provider.session.started", systemNotice: { kind: "diagnostic", presentation: "timeline", sessionId: "session-new" } });
    expect(prepareAcceptedSystemObservation({ ...base, event: startup })).toEqual({ event: startup, noticeSessionId: "session-new" });
    const unselected = event({ type: "system", subtype: "provider.session.started" });
    expect(prepareAcceptedSystemObservation({ ...base, event: unselected })).toEqual({ event: unselected, noticeSessionId: undefined });
    for (const subtype of ["sdk_session_id:provider-native-cursor", "sdk_session_invalidated"]) {
      const cursor = event({ type: "system", subtype });
      expect(prepareAcceptedSystemObservation({ ...base, event: cursor })).toEqual({ event: cursor });
    }
  });

  it("prepares exactly one deterministic completed-compaction divider and exposes accepted compaction transitions", () => {
    const started = event({ type: "compacting", active: true });
    expect(prepareAcceptedSystemObservation({ ...base, event: started })).toEqual({ event: started, compacting: true });
    const ended = event({ type: "compacting", active: false });
    const prepared = prepareAcceptedSystemObservation({ ...base, compacting: true, event: ended });
    expect(prepared).toEqual(prepareAcceptedSystemObservation({ ...base, compacting: true, event: ended }));
    expect(prepared.message).toMatchObject({ role: "system", content: "Context compacted", sequence: 12, timestamp: acceptedAt });
    expect(prepared).toMatchObject({ event: ended, compacting: false });
    expect(prepared).not.toHaveProperty("threadPatch");
    expect(prepared.message).not.toHaveProperty("systemNotice");
    const summary = event({ type: "compactSummary", summary: "The compacted conversation" });
    expect(prepareAcceptedSystemObservation({ ...base, compacting: true, event: summary })).toEqual({
      event: summary, compacting: false, threadPatch: { compactSummary: "The compacted conversation" },
    });
  });

  it("uses only reported positive context occupancy, gates estimates on usage evidence, and preserves optional window semantics", () => {
    const estimate = event({ type: "contextEstimate", tokensIn: 24_000, totalProcessedTokens: 100_000, contextWindow: 128_000 });
    expect(prepareAcceptedSystemObservation({ ...base, event: estimate })).toEqual({ event: estimate, threadPatch: { contextTokensUsed: 24_000, contextWindow: 128_000 } });
    expect(prepareAcceptedSystemObservation({ ...base, compacting: true, event: estimate })).toEqual({ event: estimate });
    const unsupportedEstimate = event({ type: "contextEstimate", tokensIn: 24_000 });
    expect(prepareAcceptedSystemObservation({ ...base, event: unsupportedEstimate })).toEqual({ event: unsupportedEstimate });
    const noWindow = event({ type: "contextEstimate", tokensIn: 9, totalProcessedTokens: 0 });
    expect(prepareAcceptedSystemObservation({ ...base, event: noWindow })).toEqual({ event: noWindow, threadPatch: { contextTokensUsed: 9 } });
    for (const tokensIn of [0, -1]) {
      const empty = event({ type: "contextEstimate", tokensIn, totalProcessedTokens: 100 });
      expect(prepareAcceptedSystemObservation({ ...base, event: empty })).toEqual({ event: empty });
    }
    expect(prepareAcceptedSystemObservation({ ...base, event: completion() }).threadPatch)
      .toEqual({ contextTokensUsed: 32_000, contextWindow: 128_000 });
    expect(() => prepareAcceptedSystemObservation({ ...base, compacting: true, event: completion() })).toThrow("active compaction");
  });

  it.each<ProviderId>(["codex", "claude", "cursor", "gemini", "copilot", "opencode", "devin"])("preserves existing provider-neutral notice and context effects for %s", (providerId) => {
    expect(prepareAcceptedSystemObservation({ ...base, providerId, event: notice() }).message?.role).toBe("system");
    expect(prepareAcceptedSystemObservation({ ...base, providerId, event: completion() }).threadPatch)
      .toEqual({ contextTokensUsed: 32_000, contextWindow: 128_000 });
  });

  it("leaves empty notices and unsupported observations without projection effects", () => {
    for (const source of [notice(""), event({ type: "system", subtype: "provider.other", message: "Status" }), event({ type: "textDelta", delta: "Answer" })]) {
      expect(prepareAcceptedSystemObservation({ ...base, event: source })).toEqual({ event: source });
    }
  });

  it("rejects foreign/missing execution routing, foreign provider usage, and invalid supplied identity/time/order", () => {
    const source = notice();
    for (const routed of [{ ...source, threadId: "another-thread" }, { ...source, turnExecutionId: "00000000-0000-4000-8000-000000000099" }, { ...source, turnExecutionId: undefined }]) {
      expect(() => prepareAcceptedSystemObservation({ ...base, event: routed })).toThrow("exact execution ownership");
    }
    expect(() => prepareAcceptedSystemObservation({ ...base, event: event({ type: "turnComplete", reason: "done", costUsd: null, tokensIn: 3, tokensOut: 1, providerId: "claude" }) })).toThrow("another provider");
    for (const invalid of [{ operationId: "" }, { operationId: "x".repeat(241) }, { operationId: " lease:8 " }, { acceptedAt: "yesterday" }, { messageSequence: -1 }, { messageSequence: 1.5 }]) {
      expect(() => prepareAcceptedSystemObservation({ ...base, ...invalid, event: source })).toThrow();
    }
    expect(prepareAcceptedSystemObservation({ ...base, operationId: "x".repeat(240), event: source }).message?.id).toBeTruthy();
  });
});
