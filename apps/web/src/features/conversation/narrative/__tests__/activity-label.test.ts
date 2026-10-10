import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { currentActivityHeading, toolActivityLabel } from "../activity-label";

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "tool", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false, ...overrides };
}

describe("tool activity label", () => {
  it.each(["Bash", "PowerShell", "Shell", "Terminal", "command_execution"])("reads the %s command on one line, never the provider description", (toolName) => {
    expect(toolActivityLabel(tool({ toolName, toolInput: { command: "bun run\n  lint", description: "Lint the web app" } }))).toBe("Running bun run lint");
  });

  it("falls back when a shell call has no command", () => {
    expect(toolActivityLabel(tool({ toolName: "Bash", toolInput: { description: "Lint the web app" } }))).toBe("Running command");
  });

  it("reads the command and file from the summarized input that live recovery stores", () => {
    expect(toolActivityLabel(tool({ toolName: "Bash", toolInput: { _summary: 'node -e "console.log(1)"' } }))).toBe('Running node -e "console.log(1)"');
    expect(toolActivityLabel(tool({ toolName: "command_execution", toolInput: { _summary: '{"command":"bun run lint"}' } }))).toBe("Running bun run lint");
    expect(toolActivityLabel(tool({ toolName: "PowerShell", toolInput: { _summary: '{"command":"node -e \\"x\\"","description":"Run node"}' } }))).toBe('Running node -e "x"');
    expect(toolActivityLabel(tool({ toolInput: { _summary: "F:\\repo\\.dev\\fixture-repo\\README.md" } }))).toBe("Reading README.md");
    expect(toolActivityLabel(tool({ toolName: "Edit", toolInput: { _summary: "/repo/app.ts" } }))).toBe("Editing app.ts");
  });

  it("names the file for Read, Edit and Write", () => {
    expect(toolActivityLabel(tool({ toolInput: { file_path: "C:\\src\\settings.ts" } }))).toBe("Reading settings.ts");
    expect(toolActivityLabel(tool({ toolName: "Edit", toolInput: { file_path: "/repo/app.ts" } }))).toBe("Editing app.ts");
    expect(toolActivityLabel(tool({ toolName: "Write", toolInput: { path: "/repo/new.md" } }))).toBe("Writing new.md");
  });

  it("uses the provider description, then the phase label, then an honest fallback, all without ellipses", () => {
    expect(toolActivityLabel(tool({ toolName: "custom_tool", toolInput: { description: "Running tests" } }))).toBe("Running tests");
    expect(toolActivityLabel(tool({ toolName: "Grep" }))).toBe("Searching the codebase");
    expect(toolActivityLabel(tool({ toolInput: { description: {} } }))).toBe("Reading files");
    expect(toolActivityLabel(tool({ toolName: "file_change" }))).toBe("Editing files");
    expect(toolActivityLabel(tool({ toolName: "mystery" }))).toBe("Working");
  });

  it("bounds labels with a hard cut and removes control characters", () => {
    expect(toolActivityLabel(tool({ toolName: "custom_tool", toolInput: { description: "Run\n\u202etests" } }))).toBe("Run tests");
    const long = toolActivityLabel(tool({ toolName: "Bash", toolInput: { command: "x".repeat(5000) } }));
    expect(long).toBe(`Running ${"x".repeat(112)}`);
    expect(long).not.toContain("…");
  });
});

describe("current activity heading", () => {
  it("never takes a heading from inside a hidden plan fence", () => {
    const text = "## Checking the README\nSummary.\n````mcode-plan\n# Plan\n## Risks and open points\n- none\n";
    expect(currentActivityHeading([{ text, startedAt: 1 }])).toBe("Checking the README");
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
