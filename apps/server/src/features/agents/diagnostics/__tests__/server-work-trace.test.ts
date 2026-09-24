import { describe, expect, it } from "vitest";
import { ServerWorkTrace, type ServerWorkTraceReport } from "../server-work-trace.js";

describe("ServerWorkTrace", () => {
  it("attributes aggregate work in a stalled tick and bounds content-free output", () => {
    const reports: ServerWorkTraceReport[] = [];
    const trace = new ServerWorkTrace((report) => reports.push(report));
    trace.tick(1_000);
    for (let index = 0; index < 40; index += 1) {
      trace.record("event-apply", "thread-a", "execution-a", 12);
    }
    trace.record("canonical-write", "thread-b", "execution-b", 30);
    trace.record("event-apply", "secret prompt with spaces", "secret output with spaces", 1);
    for (let index = 0; index < 80; index += 1) {
      trace.record("worker-wait", `thread-${index}`, "execution-c", 1);
    }
    trace.tick(1_240);

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.kind).toBe("server-work-stall");
    if (report?.kind !== "server-work-stall") return;
    expect(report.delayMs).toBe(220);
    expect(report.samples).toHaveLength(64);
    expect(report.overflowCount).toBe(19);
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
});
