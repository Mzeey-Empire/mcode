import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentPresentation, type SubagentRosterEntry } from "@mcode/contracts";
import type { ToolCall } from "@/transport/types";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { SubagentRow } from "../SubagentRow";
import { SubagentProviderScope } from "../subagent-provider";

function agent(id = "agent-1", overrides: Partial<ToolCall> = {}): ToolCall {
  return { id, toolName: "Agent", toolInput: { agentName: "Untrusted raw identity" }, output: "Private summary",
    isError: false, isComplete: false,
    subagentPresentation: createSubagentPresentation({ description: "Provisional task" }, id), ...overrides };
}

function entry(id = "agent-1", overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return { id: `call:${id}`, provider: "claude", title: "Read detection module", prompt: "Private prompt",
    subagentType: "Explore", model: null, stepCount: 2, status: "running",
    startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps", canStop: false,
    sourceToolCallId: id, sourceMessageId: "message", childThreadId: null, parentEntryId: null, ...overrides };
}

function seed(entries: SubagentRosterEntry[], revision = 1): void {
  useSubagentRosterStore.setState({ rosters: new Map([["parent", {
    owningParentThreadId: "parent", epoch: "chips-boot", revision, entries, truncated: false,
  }]]), errors: new Set() });
}

function mount(call = agent(), onSelect = vi.fn()) {
  render(<SubagentProviderScope threadId="parent">
    <SubagentRow toolCall={call} participants={[call]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={onSelect} />
  </SubagentProviderScope>);
  return onSelect;
}

describe("SubagentRow authoritative roster", () => {
  beforeEach(() => seed([entry()]));

  it("takes title, per-entry provider and status from the roster despite conflicting raw call state", () => {
    seed([entry("agent-1", { provider: "codex" })]);
    mount(agent("agent-1", { isComplete: true, isError: true }));
    expect(screen.getByRole("button", { name: "Open Read detection module subagent details" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("working");
    expect(document.querySelector('[data-provider-icon="codex"]')).toBeInTheDocument();
    expect(screen.queryByText("Untrusted raw identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Private prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Private summary")).not.toBeInTheDocument();
  });

  it.each([
    ["running", "working"], ["done", "finished"], ["failed", "failed"], ["stopped", "stopped"],
  ] as const)("announces %s as %s", (status, word) => {
    seed([entry("agent-1", { status })]);
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(word);
  });

  it("opens the stable entry id before and after a canonical child arrives", () => {
    const onSelect = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Read detection module subagent details" }));
    act(() => seed([entry("agent-1", { provider: "codex", tier: "transcript", childThreadId: "child-42" })], 2));
    fireEvent.click(screen.getByRole("button", { name: "Open Read detection module subagent details" }));
    expect(onSelect.mock.calls).toEqual([["call:agent-1", "active"], ["call:agent-1", "active"]]);
  });

  it("ignores a fake provider alias and resolves an old nested marker through its exact parent call", () => {
    seed([entry("root", { provider: "devin" })]);
    const onSelect = mount(agent("nested", {
      parentToolCallId: "root",
      subagentPresentation: createSubagentPresentation({ nativeThreadId: "fake-native" }, "nested"),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Open Read detection module subagent details" }));
    expect(onSelect.mock.calls).toEqual([["call:root", "active"]]);
  });

  it("opens meta details without claiming a transcript", () => {
    seed([entry("agent-1", { provider: "cursor", tier: "meta", status: "done" })]);
    const onSelect = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Read detection module subagent details" }));
    expect(onSelect.mock.calls).toEqual([["call:agent-1", "finished"]]);
    expect(screen.queryByTestId("subagent-transcript-unavailable")).not.toBeInTheDocument();
  });

  it("waits for the roster before enabling a provisional chip", () => {
    seed([]);
    mount();
    expect(screen.getByRole("button", { name: "Show Provisional task subagent details" })).toBeDisabled();
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => seed([entry()], 2));
    expect(screen.getByRole("button", { name: "Open Read detection module subagent details" })).toBeEnabled();
  });

  it("keeps two compact chips and aggregates remaining authoritative outcomes", () => {
    const calls = ["one", "two", "three", "four"].map((id) => agent(id));
    seed([
      entry("one", { title: "First" }), entry("two", { title: "Second" }),
      entry("three", { title: "Third", status: "stopped" }), entry("four", { title: "Fourth", status: "done" }),
    ]);
    const onOpen = vi.fn();
    const first = calls[0];
    render(<SubagentProviderScope threadId="parent">
      <SubagentRow toolCall={first} participants={calls} lifecycle="started" children={[]} hooks={[]}
        activities={calls.map((call) => ({ toolCall: call, participants: [call], lifecycle: "started", children: [], hooks: [] }))}
        onOpenSubagents={onOpen} />
    </SubagentProviderScope>);
    expect(screen.getByRole("button", { name: "Open First subagent details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Second subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("Third")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open full Subagents roster, +2 finished" }));
    expect(onOpen.mock.calls).toEqual([["finished"]]);
  });
});
