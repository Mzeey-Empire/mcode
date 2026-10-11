import { describe, expect, it } from "vitest";
import { MAX_TURN_RECOVERIES, RecoveryIncidentSchema, WS_METHODS } from "../index.js";

describe("turn recovery contracts", () => {
  it("validates retry input and trims the optional model", () => {
    const retry = WS_METHODS()["turn.retry"];
    expect(retry.params.parse({ threadId: "thread-1", turnId: "turn-1", model: "  replacement  " }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1", model: "replacement" });
    expect(retry.params.parse({ threadId: "thread-1", turnId: "turn-1" }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(retry.result.parse({ turnId: "turn-2" })).toEqual({ turnId: "turn-2" });
    expect(retry.result.safeParse({ turnId: "turn-2", extra: true }).success).toBe(false);
    expect(retry.result.safeParse({ turnId: "" }).success).toBe(false);
  });

  it.each([
    { threadId: "" }, { threadId: "t".repeat(257) }, { turnId: "" },
    { model: " " }, { model: "m".repeat(257) }, { extra: true },
  ])("rejects invalid retry input %j", (invalid) => {
    expect(WS_METHODS()["turn.retry"].params.safeParse({
      threadId: "thread-1", turnId: "turn-1", ...invalid,
    }).success).toBe(false);
  });

  it("validates resume input and reports the continuation mode", () => {
    const resume = WS_METHODS()["turn.resume"];
    expect(resume.params.parse({ threadId: "thread-1", turnId: "turn-1" }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(resume.params.safeParse({ threadId: "thread-1", turnId: "turn-1", model: "m" }).success).toBe(false);
    expect(resume.params.safeParse({ threadId: "", turnId: "turn-1" }).success).toBe(false);
    expect(resume.result.parse({ turnId: "turn-2", mode: "native-session" }))
      .toEqual({ turnId: "turn-2", mode: "native-session" });
    expect(resume.result.parse({ turnId: "turn-2", mode: "seeded-session" }).mode).toBe("seeded-session");
    expect(resume.result.safeParse({ turnId: "turn-2", mode: "fresh" }).success).toBe(false);
  });

  const incident = {
    id: "00000000-0000-4000-8000-000000000015",
    createdAt: "2026-08-10T09:03:00.000Z",
    entries: [{
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      threadId: "thread-1",
      threadTitle: "Recovery",
      executionId: "00000000-0000-4000-8000-000000000016",
      startedAt: "2026-08-10T09:00:00.000Z",
      interruptedAt: "2026-08-10T09:03:00.000Z",
      durationMs: 180_000,
    }],
  };

  it("returns one restart-scoped incident or null", () => {
    expect(RecoveryIncidentSchema().parse(incident)).toEqual(incident);
    expect(WS_METHODS()["agent.recoveryIncident"].result.parse(null)).toBeNull();
    expect(WS_METHODS()["agent.recoveryIncident"].result.parse(incident)).toEqual(incident);
    expect(WS_METHODS()["agent.retry"]).toBeDefined();
  });

  it("rejects an entry with a negative duration", () => {
    expect(RecoveryIncidentSchema().safeParse({
      ...incident,
      entries: [{ ...incident.entries[0], durationMs: -1 }],
    }).success).toBe(false);
  });

  it("rejects recovery result overflow", () => {
    expect(WS_METHODS()["agent.recoveryIncident"].result.safeParse({
      ...incident,
      entries: Array.from({ length: MAX_TURN_RECOVERIES + 1 }, () => incident.entries[0]),
    }).success).toBe(false);
  });
});
