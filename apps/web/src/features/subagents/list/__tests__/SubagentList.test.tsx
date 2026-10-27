import { mockTransport } from "@/__tests__/mocks/transport";
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRoster, SubagentRosterEntry } from "@mcode/contracts";
import { pushEmitter } from "@/transport";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentsPanel } from "../../roster/SubagentsPanel";
import { SubagentList } from "../SubagentList";

const transport = {
  loadSubagentRoster: vi.mocked(mockTransport.loadSubagentRoster),
  loadSubagentDetail: vi.mocked(mockTransport.loadSubagentDetail),
  stopCanonicalSubagent: vi.mocked(mockTransport.stopCanonicalSubagent),
};
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.loadSubagentRoster).mockReset();
  vi.mocked(mockTransport.loadSubagentDetail).mockReset();
  vi.mocked(mockTransport.stopCanonicalSubagent).mockReset();
});

const START = Date.parse("2026-10-10T10:00:00.000Z");

function at(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

function entry(title: string, overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return {
    id: `call:${title}`, provider: "claude", title, prompt: null, subagentType: null, model: null, reasoningEffort: null,
    stepCount: 0, status: "running", startedAt: at(0), endedAt: null, tier: "steps", canStop: false,
    sourceToolCallId: title, childThreadId: null, sourceMessageId: null, parentEntryId: null,
    ...overrides,
  };
}

function codex(title: string, overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return entry(title, { provider: "codex", tier: "transcript", canStop: true, childThreadId: `child-${title}`, ...overrides });
}

function roster(entries: SubagentRosterEntry[], revision = 1): SubagentRoster {
  return { owningParentThreadId: "parent", epoch: "list-boot", revision, entries, truncated: false };
}

function rowOrder(): string[] {
  return screen.getAllByRole("listitem", { hidden: true })
    .map((item) => item.querySelector("[data-subagent-id]")?.getAttribute("data-subagent-id") ?? "divider");
}

describe("SubagentList in the Subagents panel", () => {
  beforeEach(() => {
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    transport.loadSubagentRoster.mockReset();
    transport.loadSubagentDetail.mockReset();
    transport.stopCanonicalSubagent.mockReset();
  });

  it("orders running rows newest first, then a divider, then finished rows newest first", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([
      entry("old done", { status: "done", startedAt: at(0), endedAt: at(30) }),
      codex("old running", { startedAt: at(10) }),
      entry("new failed", { provider: "cursor", status: "failed", startedAt: at(40), endedAt: at(50) }),
      entry("new running", { startedAt: at(60) }),
      codex("mid stopped", { status: "stopped", startedAt: at(20), endedAt: at(25) }),
    ]));
    render(<SubagentsPanel threadId="parent" />);
    await screen.findByRole("button", { name: "Open new running details, Running" });

    expect(rowOrder()).toEqual([
      "call:new running", "call:old running", "divider", "call:new failed", "call:mid stopped", "call:old done",
    ]);
  });

  it("groups a child waiting on the user with running rows", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([
      entry("old done", { status: "done", startedAt: at(0), endedAt: at(30) }),
      codex("asking", { status: "waiting", startedAt: at(40) }),
      entry("working", { startedAt: at(20) }),
    ]));
    render(<SubagentsPanel threadId="parent" />);
    await screen.findByRole("button", { name: "Open asking details, Waiting" });

    expect(rowOrder()).toEqual(["call:asking", "call:working", "divider", "call:old done"]);
  });

  it("offers Stop only on running rows that can stop", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([
      codex("codex child"),
      entry("claude child"),
      codex("codex finished", { status: "done", endedAt: at(5) }),
    ]));
    render(<SubagentsPanel threadId="parent" />);
    await screen.findByRole("button", { name: "Open codex child details, Running" });

    expect(screen.getAllByRole("button", { name: /^Stop / }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Stop codex child"]);
    expect(screen.queryByRole("button", { name: "Stop all" })).not.toBeInTheDocument();
  });

  it("turns a stopped row Stopped from the roster push without reopening the panel", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([codex("worker")]));
    transport.stopCanonicalSubagent.mockResolvedValue({ childThreadId: "child-worker", status: "interrupted" });
    render(<SubagentsPanel threadId="parent" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop worker" }));
    await waitFor(() => expect(transport.loadSubagentRoster).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Open worker details, Running" })).toBeInTheDocument();

    transport.loadSubagentRoster.mockResolvedValue(roster([codex("worker", { status: "stopped", endedAt: at(72) })], 2));
    await act(async () => {
      pushEmitter.emit("subagents.changed", { threadId: "parent", epoch: "list-boot", revision: 2 });
    });

    expect(transport.stopCanonicalSubagent.mock.calls).toEqual([["parent", "child-worker"]]);
    const row = await screen.findByRole("button", { name: "Open worker details, Stopped" });
    expect(row).toHaveTextContent("Stopped1m 12s");
    expect(screen.queryByRole("button", { name: "Stop worker" })).not.toBeInTheDocument();
  });

  it("returns focus to the row after it stops and moves below the divider", async () => {
    transport.loadSubagentRoster.mockResolvedValueOnce(roster([codex("worker"), entry("other")]))
      .mockResolvedValue(roster([codex("worker", { status: "stopped", endedAt: at(5) }), entry("other")], 2));
    transport.stopCanonicalSubagent.mockResolvedValue({ childThreadId: "child-worker", status: "interrupted" });
    render(<SubagentsPanel threadId="parent" />);
    const stop = await screen.findByRole("button", { name: "Stop worker" });
    stop.focus();

    fireEvent.click(stop);

    const row = await screen.findByRole("button", { name: "Open worker details, Stopped" });
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("explains an empty roster", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([]));
    render(<SubagentsPanel threadId="parent" />);
    expect(await screen.findByTestId("subagents-empty")).toHaveTextContent("Subagents appear here when this thread delegates work.");
  });

  it("shows a load error with Retry that reloads the roster", async () => {
    transport.loadSubagentRoster.mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce(roster([entry("Inspect UI")]));
    render(<SubagentsPanel threadId="parent" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load subagents");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByRole("button", { name: "Open Inspect UI details, Running" });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("SubagentList live time", () => {
  afterEach(() => { vi.useRealTimers(); });

  function renderList(entries: SubagentRosterEntry[]) {
    return render(<SubagentList roster={roster(entries)} error={false} viewportRef={createRef()}
      onRetry={vi.fn()} onSelect={vi.fn()} onStop={vi.fn()} />);
  }

  it("ticks a running row every second and shows a finished row's fixed duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 48_000);
    renderList([entry("live"), entry("finished", { status: "done", endedAt: at(3780) })]);

    expect(screen.getByRole("button", { name: "Open live details, Running" })).toHaveTextContent("48s");
    expect(screen.getByRole("button", { name: "Open finished details, Done" })).toHaveTextContent("1h 3m");
    act(() => { vi.advanceTimersByTime(24_000); });
    expect(screen.getByRole("button", { name: "Open live details, Running" })).toHaveTextContent("1m 12s");
  });

  it("shows no duration for a finished row without an end time while another row ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 48_000);
    renderList([entry("live"), entry("stopped", { status: "stopped", endedAt: null })]);

    act(() => { vi.advanceTimersByTime(5_000); });

    expect(screen.getByRole("button", { name: "Open stopped details, Stopped" })).toHaveTextContent(/^stoppedStopped$/);
  });

  it("schedules no timer when nothing is running", () => {
    const interval = vi.spyOn(window, "setInterval");
    renderList([entry("finished", { status: "failed", endedAt: at(9) })]);

    expect(screen.getByRole("button", { name: "Open finished details, Failed" })).toHaveTextContent("Failed9s");
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});
