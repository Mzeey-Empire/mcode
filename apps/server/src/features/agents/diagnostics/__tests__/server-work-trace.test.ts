import { describe, expect, it } from "vitest";
import { eventApplyType, ServerWorkTrace, type ServerWorkTraceReport } from "../server-work-trace.js";

describe("ServerWorkTrace", () => {
  it("attributes aggregate work in a stalled tick and bounds content-free output", () => {
    const reports: ServerWorkTraceReport[] = [];
    const trace = new ServerWorkTrace((report) => reports.push(report));
    trace.tick(1_000);
    for (let index = 0; index < 40; index += 1) {
      trace.record("event-apply", "thread-a", "execution-a", 12, "textDelta");
    }
    trace.record("canonical-write", "thread-b", "execution-b", 30);
    trace.record("event-apply", "secret prompt with spaces", "secret output with spaces", 1, "other");
    for (let index = 0; index < 80; index += 1) {
      trace.record("worker-wait", `thread-${index}`, "execution-c", 1);
    }
    trace.record("event-apply", "thread-overflow", "execution-d", 9, "toolResult");
    trace.record("narrative-checkpoint", "thread-overflow", "execution-d", 7);
    trace.record("narrative-prepare", "thread-overflow", "execution-d", 4);
    trace.record("narrative-persist", "thread-overflow", "execution-d", 2);
    trace.record("narrative-confirm", "thread-overflow", "execution-d", 1);
    trace.tick(1_240);

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.kind).toBe("server-work-stall");
    if (report?.kind !== "server-work-stall") return;
    expect(report.delayMs).toBe(220);
    expect(report.samples).toHaveLength(64);
    expect(report.overflowCount).toBe(24);
    expect(report.eventApplyByType.textDelta).toEqual({ count: 40, totalMs: 480, maxMs: 12 });
    expect(report.eventApplyByType.toolResult).toEqual({ count: 1, totalMs: 9, maxMs: 9 });
    expect(report.eventApplyByType.other).toEqual({ count: 1, totalMs: 1, maxMs: 1 });
    expect(report.narrativeCheckpoint).toEqual({ count: 1, totalMs: 7, maxMs: 7 });
    expect(report.narrativeCheckpointByStep).toEqual({
      "narrative-prepare": { count: 1, totalMs: 4, maxMs: 4 },
      "narrative-persist": { count: 1, totalMs: 2, maxMs: 2 },
      "narrative-confirm": { count: 1, totalMs: 1, maxMs: 1 },
    });
    expect(report.samples[0]).toEqual({
      phase: "event-apply", threadId: "thread-a", executionId: "execution-a",
      count: 40, totalMs: 480, maxMs: 12,
    });
    expect(report.samples[1]).toEqual({
      phase: "canonical-write", threadId: "thread-b", executionId: "execution-b",
      count: 1, totalMs: 30, maxMs: 30,
    });
    expect(report.samples[2]).toMatchObject({ threadId: null, executionId: null });
    expect(JSON.stringify(report)).not.toMatch(/prompt|toolInput|output|secret/);

    trace.tick(1_260);
    expect(reports).toHaveLength(1);
  });

  it("classifies only the fixed event type across threads", () => {
    const reports: ServerWorkTraceReport[] = [];
    const trace = new ServerWorkTrace((report) => reports.push(report));
    trace.tick(1_000);
    const types = ["textDelta", "toolUse", "toolResult", "assistantMessageBoundary", "unrecognized"];
    types.forEach((type, index) => {
      trace.record("event-apply", `thread-${index}`, "execution-a", index + 1, eventApplyType(type));
      trace.record("narrative-checkpoint", `thread-${index}`, "execution-a", index + 2);
      trace.record("narrative-prepare", `thread-${index}`, "execution-a", index + 1);
      trace.record("narrative-persist", `thread-${index}`, "execution-a", 1);
      trace.record("narrative-confirm", `thread-${index}`, "execution-a", 1);
    });
    trace.tick(1_200);
    const report = reports[0];
    expect(report?.kind).toBe("server-work-stall");
    if (report?.kind !== "server-work-stall") return;
    expect(report.eventApplyByType).toEqual({
      textDelta: { count: 1, totalMs: 1, maxMs: 1 },
      toolUse: { count: 1, totalMs: 2, maxMs: 2 },
      toolResult: { count: 1, totalMs: 3, maxMs: 3 },
      assistantMessageBoundary: { count: 1, totalMs: 4, maxMs: 4 },
      other: { count: 1, totalMs: 5, maxMs: 5 },
    });
    expect(report.narrativeCheckpoint).toEqual({ count: 5, totalMs: 20, maxMs: 6 });
    expect(report.narrativeCheckpointByStep).toEqual({
      "narrative-prepare": { count: 5, totalMs: 15, maxMs: 5 },
      "narrative-persist": { count: 5, totalMs: 5, maxMs: 1 },
      "narrative-confirm": { count: 5, totalMs: 5, maxMs: 1 },
    });
  });
});
