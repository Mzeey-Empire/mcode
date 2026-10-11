import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { BackgroundToolSettlementEffect, ORPHANED_BACKGROUND_TOOL_OUTPUT } from "../background-tool-settlement-effect.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000124";

function harness(held: { threadId: string; executionId: string; toolCallId: string }[] = []) {
  const steps: string[] = [];
  const subagentToolChanged = vi.fn((threadId: string, toolCallId: string) => { steps.push(`roster:${threadId}:${toolCallId}`); });
  const effect = new BackgroundToolSettlementEffect({ listHeldBackgroundToolCalls: () => held }, { subagentToolChanged });
  const acceptLateToolResult = vi.fn((threadId: string, _executionId: string, result: { toolCallId: string; status: string }) => {
    steps.push(`accept:${threadId}:${result.toolCallId}:${result.status}`);
  });
  const waitForSaved = vi.fn(async (threadId: string) => { steps.push(`saved:${threadId}`); });
  return { effect, steps, acceptLateToolResult, waitForSaved, bind: () => effect.bindAcceptedProgress({ acceptLateToolResult, waitForSaved }) };
}

describe("BackgroundToolSettlementEffect", () => {
  it("rejects a settlement when accepted progress was not composed", () => {
    const { effect } = harness();
    expect(() => effect.settle({ threadId: "thread", executionId: EXECUTION_ID, toolCallId: "agent", status: "completed", output: "" }))
      .toThrow("requires accepted progress composition");
  });

  it("refreshes the roster only after the late result is admitted", () => {
    const { effect, steps, acceptLateToolResult, bind } = harness();
    bind();
    effect.settle({ threadId: "thread", executionId: EXECUTION_ID, toolCallId: "agent", status: "failed", output: "Crashed" });
    expect(acceptLateToolResult).toHaveBeenCalledExactlyOnceWith("thread", EXECUTION_ID,
      { toolCallId: "agent", status: "failed", output: "Crashed" });
    expect(steps).toEqual(["accept:thread:agent:failed", "roster:thread:agent"]);
  });

  it("does not notify the roster when admission rejects the result", () => {
    const { effect, steps, acceptLateToolResult, bind } = harness();
    acceptLateToolResult.mockImplementationOnce(() => { throw new Error("Late tool result conflicts"); });
    bind();
    expect(() => effect.settle({ threadId: "thread", executionId: EXECUTION_ID, toolCallId: "agent", status: "completed", output: "" }))
      .toThrow("conflicts");
    expect(steps).toEqual([]);
  });

  it("stops every orphan and lets each thread's writes land before the next thread", async () => {
    const held = [
      { threadId: "first", executionId: EXECUTION_ID, toolCallId: "a" },
      { threadId: "first", executionId: EXECUTION_ID, toolCallId: "b" },
      { threadId: "second", executionId: EXECUTION_ID, toolCallId: "c" },
    ];
    const { effect, steps, acceptLateToolResult, bind } = harness(held);
    bind();
    await expect(effect.settleOrphansAtStartup()).resolves.toBe(3);
    expect(acceptLateToolResult).toHaveBeenCalledWith("first", EXECUTION_ID,
      { toolCallId: "a", status: "cancelled", output: ORPHANED_BACKGROUND_TOOL_OUTPUT });
    expect(steps).toEqual([
      "accept:first:a:cancelled", "roster:first:a",
      "accept:first:b:cancelled", "roster:first:b", "saved:first",
      "accept:second:c:cancelled", "roster:second:c", "saved:second",
    ]);
  });
});
