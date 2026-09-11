import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { currentActivityHeading, narrativeActivityLabel } from "../activity-label";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "tool", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false, ...overrides };
}

describe("narrative activity", () => {
  it("uses provider-supplied tool detail before the summary without requiring a provider ID", () => {
    expect(narrativeActivityLabel([tool({ toolName: "custom_tool", toolInput: { description: "Running tests" } })], "Inspecting layout")).toBe("Running tests");
  });

  it("selects the latest active root action and ignores completed and child work", () => {
    expect(narrativeActivityLabel([
      tool({ toolInput: { file_path: "C:\\src\\settings.ts" } }),
      tool({ isComplete: true, toolInput: { description: "Old work" } }),
      tool({ parentToolCallId: "parent", toolInput: { description: "Child work" } }),
    ])).toBe("Reading settings.ts");
    expect(narrativeActivityLabel([tool({ isComplete: true })], "Checking layout")).toBe("Checking layout");
    expect(narrativeActivityLabel([tool({ isComplete: true })])).toBe("Thinking...");
  });

  it.each(["Bash", "Shell", "Terminal", "command_execution"])("uses an honest action fallback for %s without exposing command arguments", (toolName) => {
    expect(narrativeActivityLabel([tool({ toolName, toolInput: { command: "arbitrary command" } })])).toBe("Running a command...");
  });

  it("bounds labels and removes control characters", () => {
    expect(narrativeActivityLabel([tool({ toolInput: { description: "Run\n\u202etests" } })])).toBe("Run tests");
    expect(narrativeActivityLabel([tool({ toolInput: { description: "x".repeat(5000) } })])).toHaveLength(120);
    expect(narrativeActivityLabel([tool({ toolInput: { description: {} } })])).toBe("Reading files...");
  });

  it("waits for complete headings and does not change as the body streams", () => {
    const heading = (text: string) => currentActivityHeading([{ text, startedAt: 1 }]);
    expect(heading("**Inspecting lay")).toBeUndefined();
    expect(heading("**Inspecting layout**")).toBe("Inspecting layout");
    expect(heading("**Inspecting layout**\n\nText keeps streaming")).toBe("Inspecting layout");
    expect(heading("**Inspecting layout**\n\n## Checking tests")).toBe("Inspecting layout");
    expect(heading("**Inspecting layout**\n\n## Checking tests\n")).toBe("Checking tests");
    expect(heading("Plain prose is not a heading")).toBeUndefined();
  });

  it("clears headings when the segment closes or the turn changes", () => {
    expect(currentActivityHeading([{ text: "**Old work**", startedAt: 1, endedAt: 2 }])).toBeUndefined();
    expect(currentActivityHeading([{ text: "**Old work**", startedAt: 1, endedAt: 2 }, { text: "New prose", startedAt: 3 }])).toBeUndefined();
    expect(currentActivityHeading([])).toBeUndefined();
  });
});
