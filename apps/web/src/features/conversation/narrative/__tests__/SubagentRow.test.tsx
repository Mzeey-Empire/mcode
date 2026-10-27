import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentPresentation } from "@mcode/contracts/models/tool-call-record";
import { type SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import type { ToolCall } from "@/transport/types";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { NarrativeRow } from "../NarrativeRow";
import { SubagentRow } from "../SubagentRow";
import { SubagentProviderScope } from "../subagent-provider";
import type { SubagentActivity } from "../types";

function agent(id = "agent-1", overrides: Partial<ToolCall> = {}): ToolCall {
  return { id, toolName: "Agent", toolInput: { agentName: "Untrusted raw identity" }, output: "Private summary",
    isError: false, isComplete: false,
    subagentPresentation: createSubagentPresentation({ description: "Provisional task" }, id), ...overrides };
}

function entry(id = "agent-1", overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return { id: `call:${id}`, provider: "claude", title: "Read detection module", prompt: "Private prompt",
    subagentType: "Explore", model: null, reasoningEffort: null, stepCount: 2, status: "running",
    startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps", canStop: false,
    sourceToolCallId: id, sourceMessageId: "message", childThreadId: null, parentEntryId: null, ...overrides };
}

function seed(entries: SubagentRosterEntry[], revision = 1, epoch = "chips-boot"): void {
  useSubagentRosterStore.setState({ rosters: new Map([["parent", {
    owningParentThreadId: "parent", epoch, revision, entries, truncated: false,
  }]]), errors: new Set() });
}

function activity(call: ToolCall): SubagentActivity {
  return { toolCall: call, participants: [call], lifecycle: "started", children: [], hooks: [] };
}

function mount(call = agent(), onSelect = vi.fn()) {
  render(<SubagentProviderScope threadId="parent">
    <SubagentRow participants={[call]} onSubagentSelect={onSelect} />
  </SubagentProviderScope>);
  return onSelect;
}

function mountParallel(calls: ToolCall[], onOpen = vi.fn()) {
  render(<SubagentProviderScope threadId="parent">
    <SubagentRow participants={calls} activities={calls.map(activity)} onOpenSubagents={onOpen} />
  </SubagentProviderScope>);
  return onOpen;
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
    ["running", "working"], ["done", "finished"],
    ["failed", "failed"], ["stopped", "stopped"],
  ] as const)("shows %s as %s inside the chip", (status, word) => {
    seed([entry("agent-1", { status })]);
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(word);
    const chip = screen.getByRole("button", { name: "Open Read detection module subagent details" });
    expect(within(chip).getByText(word)).toBeInTheDocument();
  });

  it("shows each subagent under its own provider after the thread switched providers", () => {
    seed([entry("one", { title: "Claude task", provider: "claude" }), entry("two", { title: "Codex task", provider: "codex" })]);
    mountParallel([agent("one"), agent("two")]);
    const claudeChip = screen.getByRole("button", { name: "Open Claude task subagent details" });
    const codexChip = screen.getByRole("button", { name: "Open Codex task subagent details" });
    expect(claudeChip.querySelector("[data-provider-icon]")).toHaveAttribute("data-provider-icon", "claude");
    expect(codexChip.querySelector("[data-provider-icon]")).toHaveAttribute("data-provider-icon", "codex");
  });

  it("follows the roster's word after a reconnect reseeds a new epoch", () => {
    seed([entry("agent-1", { status: "running" })], 4, "epoch-a");
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("working");
    act(() => seed([entry("agent-1", { status: "done" })], 1, "epoch-b"));
    expect(screen.getByRole("status")).toHaveTextContent("finished");
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

  it("opens a finished entry with the finished target", () => {
    seed([entry("agent-1", { provider: "cursor", tier: "meta", status: "done" })]);
    const onSelect = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Read detection module subagent details" }));
    expect(onSelect.mock.calls).toEqual([["call:agent-1", "finished"]]);
  });

  it("shows only the title until the roster has the entry", () => {
    seed([]);
    mount();
    const chip = screen.getByRole("button", { name: "Show Provisional task subagent details" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveTextContent(/^Provisional task$/);
    expect(document.querySelector("[data-provider-icon]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => seed([entry()], 2));
    expect(screen.getByRole("button", { name: "Open Read detection module subagent details" })).toBeEnabled();
  });

  it("renders no child rows", () => {
    const parent = agent("agent-1");
    const read: ToolCall = { id: "child-read", toolName: "Read", toolInput: { file_path: "src/detect.ts" },
      output: "contents", isError: false, isComplete: true, parentToolCallId: "agent-1" };
    const grep: ToolCall = { id: "child-grep", toolName: "Grep", toolInput: { pattern: "detect" },
      output: "matches", isError: false, isComplete: true, parentToolCallId: "agent-1" };
    const { container } = render(<SubagentProviderScope threadId="parent">
      <NarrativeRow rowId="row" item={{
        type: "subagent", lifecycle: "started", toolCall: parent, participants: [parent], children: [read, grep], hooks: [],
      }} />
    </SubagentProviderScope>);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Open Read detection module subagent details"]);
    for (const childText of ["Grep", "src/detect.ts", "contents", "matches", "detect\""]) {
      expect(container.textContent).not.toContain(childText);
    }
    expect(container.querySelector('[data-tool-call-id="child-read"], [data-tool-call-id="child-grep"]')).toBeNull();
  });

  it("keeps two chips and aggregates the rest as working and finished", () => {
    seed([
      entry("one", { title: "First" }), entry("two", { title: "Second" }),
      entry("three", { title: "Third" }), entry("four", { title: "Fourth" }),
      entry("five", { title: "Fifth", status: "done" }),
    ]);
    const onOpen = mountParallel(["one", "two", "three", "four", "five"].map((id) => agent(id)));
    expect(screen.getByRole("button", { name: "Open First subagent details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Second subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("Third")).not.toBeInTheDocument();
    const overflow = screen.getByRole("button", { name: "Open full Subagents roster, +2 working, 1 finished" });
    expect(overflow).toHaveTextContent("+2 working, 1 finished");
    fireEvent.click(overflow);
    expect(onOpen.mock.calls).toEqual([["active"]]);
  });

  it("drops the plus sign from finished when nothing remaining is working", () => {
    seed([
      entry("one", { title: "First" }), entry("two", { title: "Second" }),
      entry("three", { title: "Third", status: "stopped" }), entry("four", { title: "Fourth", status: "done" }),
    ]);
    const onOpen = mountParallel(["one", "two", "three", "four"].map((id) => agent(id)));
    fireEvent.click(screen.getByRole("button", { name: "Open full Subagents roster, +2 finished" }));
    expect(onOpen.mock.calls).toEqual([["finished"]]);
  });
});
