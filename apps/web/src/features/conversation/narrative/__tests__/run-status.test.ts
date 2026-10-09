import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { deriveRunStatus, type RunStatusInput } from "../run-status";

const idle: RunStatusInput = { stopPending: false, compacting: false, subagentsRunning: false, answering: false };
const lint: ToolCall = { id: "lint", toolName: "Bash", toolInput: { command: "bun run lint" }, output: null, isError: false, isComplete: false };

describe("deriveRunStatus", () => {
  it.each<[string, Partial<RunStatusInput>, { label: string; icon: "layers" | "spinner" }]>([
    ["stop in flight", { stopPending: true }, { label: "Stopping", icon: "spinner" }],
    ["compacting", { compacting: true }, { label: "Compacting context", icon: "spinner" }],
    ["rate limited", { retry: "rate-limited" }, { label: "Rate limited", icon: "spinner" }],
    ["retrying", { retry: "retrying" }, { label: "Retrying", icon: "spinner" }],
    ["pending approval", { waitingFor: "approval" }, { label: "Waiting for approval", icon: "layers" }],
    ["plan questions", { waitingFor: "answers" }, { label: "Waiting for your answers", icon: "layers" }],
    ["tool running", { activeTool: lint }, { label: "Running bun run lint", icon: "layers" }],
    ["only subagents running", { subagentsRunning: true }, { label: "Waiting on subagents", icon: "layers" }],
    ["answer streaming", { answering: true }, { label: "Answering", icon: "layers" }],
    ["summary heading", { summaryHeading: "Inspecting layout" }, { label: "Inspecting layout", icon: "layers" }],
    ["nothing else", {}, { label: "Thinking", icon: "layers" }],
  ])("reads %s", (_name, input, expected) => {
    expect(deriveRunStatus({ ...idle, ...input })).toEqual(expected);
  });

  it("lets a higher row win when several states hold", () => {
    const everything: RunStatusInput = {
      stopPending: true, compacting: true, retry: "retrying", waitingFor: "approval",
      activeTool: lint, subagentsRunning: true, answering: true, summaryHeading: "Inspecting layout",
    };
    expect(deriveRunStatus(everything)).toEqual({ label: "Stopping", icon: "spinner" });
    expect(deriveRunStatus({ ...everything, stopPending: false })).toEqual({ label: "Compacting context", icon: "spinner" });
    expect(deriveRunStatus({ ...idle, activeTool: lint, subagentsRunning: true, answering: true })).toEqual({ label: "Running bun run lint", icon: "layers" });
    expect(deriveRunStatus({ ...idle, subagentsRunning: true, answering: true })).toEqual({ label: "Waiting on subagents", icon: "layers" });
    expect(deriveRunStatus({ ...idle, answering: true, summaryHeading: "Inspecting layout" })).toEqual({ label: "Answering", icon: "layers" });
  });
});
