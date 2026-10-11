import type { ToolCallRecord } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { settledLateToolRecord } from "../late-tool-result-events.js";

const NOW = "2026-09-30T10:00:00.000Z";
const LATER = "2026-09-30T10:05:00.000Z";
const held: ToolCallRecord = { id: "agent", message_id: "message", parent_tool_call_id: null, tool_name: "Agent",
  input_summary: "", output_summary: "", status: "running", background: true, started_at: NOW, completed_at: null, sort_order: 0 };

describe("late tool result settlement", () => {
  it("bounds a long summary and treats its redelivery as already settled", () => {
    const result = { toolCallId: "agent", status: "completed", output: "x".repeat(2_000) } as const;
    const settled = settledLateToolRecord(held, result, "message", LATER);
    expect(settled).toMatchObject({ status: "completed", output_summary: "x".repeat(500), completed_at: LATER, background: true });
    if (!settled) throw new Error("Expected a settled record");
    expect(settledLateToolRecord(settled, result, "message", LATER)).toBeNull();
  });

  it("rejects a late result for a call its turn still owns", () => {
    const { background: _background, ...owned } = held;
    expect(() => settledLateToolRecord(owned, { toolCallId: "agent", status: "completed", output: "" }, "message", LATER))
      .toThrow("requires a background tool call");
  });
});
