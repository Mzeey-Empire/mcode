import { describe, expect, it } from "vitest";
import { deriveTaskState, type TaskFacts } from "./task-state.js";

describe("delegated task state", () => {
  it.each<{ name: string; facts: TaskFacts; expected: unknown }>([
    { name: "completed turn wins over later thread activity", facts: { turn: { status: "Completed" }, summary: "Implemented" }, expected: { status: "finished", outcome: "completed", summary: "Implemented" } },
    { name: "errored turn", facts: { turn: { status: "Errored" }, error: "Provider failed" }, expected: { status: "finished", outcome: "failed", error: "Provider failed" } },
    { name: "cancelled turn", facts: { turn: { status: "Cancelled" } }, expected: { status: "finished", outcome: "cancelled" } },
    { name: "interrupted is resumable", facts: { turn: { status: "Interrupted" } }, expected: { status: "finished", outcome: "interrupted" } },
    { name: "pending turn needs input", facts: { turn: { status: "Pending" }, needsInput: true }, expected: { status: "waiting", reason: "needs_input" } },
    { name: "running turn needs input", facts: { turn: { status: "Running" }, needsInput: true }, expected: { status: "waiting", reason: "needs_input" } },
    { name: "pending turn", facts: { turn: { status: "Pending" } }, expected: { status: "working", phase: "running" } },
    { name: "reopened running turn", facts: { turn: { status: "Running" }, approval: "rejected" }, expected: { status: "working", phase: "running" } },
    { name: "blocked setup", facts: { startup: { state: "blocked", phase: "setup" } }, expected: { status: "waiting", reason: "setup_blocked" } },
    { name: "failed startup", facts: { startup: { state: "failed", phase: "agent", error: { message: "Could not start" } } }, expected: { status: "finished", outcome: "failed", error: "Could not start" } },
    { name: "interrupted startup", facts: { startup: { state: "interrupted", phase: "worktree" } }, expected: { status: "finished", outcome: "failed" } },
    { name: "cancelled startup", facts: { startup: { state: "cancelled", phase: "setup" } }, expected: { status: "finished", outcome: "cancelled" } },
    { name: "preparing startup", facts: { startup: { state: "running", phase: "worktree" } }, expected: { status: "working", phase: "preparing" } },
    { name: "pending approval", facts: { approval: "pending" }, expected: { status: "waiting", reason: "approval" } },
    { name: "rejected approval", facts: { approval: "rejected" }, expected: { status: "finished", outcome: "denied" } },
    { name: "expired approval", facts: { approval: "expired" }, expected: { status: "finished", outcome: "denied" } },
    { name: "cancelled approval", facts: { approval: "cancelled" }, expected: { status: "finished", outcome: "cancelled" } },
    { name: "launch in flight", facts: { launching: true }, expected: { status: "working", phase: "preparing" } },
    { name: "missing execution is an honest failure", facts: {}, expected: { status: "finished", outcome: "failed", error: "not started; call delegate_task again with the same clientRequestId" } },
  ])("$name", ({ facts, expected }) => {
    expect(deriveTaskState(facts)).toEqual(expected);
  });

  it("bounds the summary and reflects a reopened turn instead of freezing the receipt", () => {
    expect(deriveTaskState({ turn: { status: "Completed" }, summary: "x".repeat(20_000) }))
      .toEqual({ status: "finished", outcome: "completed", summary: "x".repeat(8_000) });
    expect(deriveTaskState({ turn: { status: "Running" } })).toEqual({ status: "working", phase: "running" });
  });
});
