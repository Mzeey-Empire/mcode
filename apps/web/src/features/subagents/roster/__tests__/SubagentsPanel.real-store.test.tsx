import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRoster, SubagentRosterEntry } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { pushEmitter } from "@/transport";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentsPanel } from "../SubagentsPanel";

const transport = vi.hoisted(() => ({ loadSubagentRoster: vi.fn(), loadSubagentDetail: vi.fn(), stopCanonicalSubagent: vi.fn() }));
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => transport,
}));

function row(id: string, status: SubagentRosterEntry["status"] = "running"): SubagentRosterEntry {
  return {
    id: `call:${id}`, provider: "claude", title: id, prompt: "Inspect the project",
    subagentType: "Explore", model: null, stepCount: 0, status,
    startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps", canStop: false,
    sourceToolCallId: id, childThreadId: null, sourceMessageId: "message", parentEntryId: null,
  };
}
function roster(entries: SubagentRosterEntry[], revision = 1): SubagentRoster {
  return { owningParentThreadId: "thread-1", epoch: "panel-boot", revision, entries, truncated: false };
}

describe("SubagentsPanel real roster store", () => {
  beforeEach(() => {
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    useDiffStore.setState({ subagentDetailByThread: {} });
    useThreadStore.setState({ currentThreadId: "thread-1", records: new Map() });
    transport.loadSubagentRoster.mockReset();
    transport.loadSubagentDetail.mockReset();
  });

  it("shows an empty roster without requiring a hydrated conversation", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([]));
    render(<SubagentsPanel threadId="thread-1" />);
    await screen.findByTestId("subagents-empty");
    expect(transport.loadSubagentRoster.mock.calls).toEqual([["thread-1"]]);
  });

  it("renders both Claude calls and updates them on push without an interval", async () => {
    const interval = vi.spyOn(window, "setInterval");
    transport.loadSubagentRoster.mockResolvedValueOnce(roster([row("Inspect UI"), row("Inspect API")]))
      .mockResolvedValueOnce(roster([row("Inspect UI", "done"), row("Inspect API", "done")], 2));
    await act(async () => { render(<SubagentsPanel threadId="thread-1" />); });
    expect(screen.getAllByTestId("subagent-active-row")).toHaveLength(2);
    expect(interval).not.toHaveBeenCalled();
    await act(async () => {
      pushEmitter.emit("subagents.changed", { threadId: "thread-1", epoch: "panel-boot", revision: 2 });
      await useSubagentRosterStore.getState().refresh("thread-1");
    });
    expect(screen.queryAllByTestId("subagent-active-row")).toHaveLength(0);
    expect(screen.getAllByTestId("subagent-finished-row")).toHaveLength(2);
    expect(transport.loadSubagentRoster).toHaveBeenCalledTimes(2);
    interval.mockRestore();
  });

  it("keeps an open entry selected after refresh and loads server steps", async () => {
    transport.loadSubagentRoster.mockResolvedValue(roster([row("Inspect UI")]));
    transport.loadSubagentDetail.mockResolvedValue({
      entryId: "call:Inspect UI", totalSteps: 0, steps: [], summary: "No issues found",
    });
    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Inspect UI details, Running" }));
    await screen.findByText("No issues found");
    expect(useDiffStore.getState().subagentDetailByThread["thread-1"]?.id).toBe("call:Inspect UI");
    transport.loadSubagentRoster.mockResolvedValue(roster([row("Inspect UI", "stopped")], 3));
    await act(async () => { await useSubagentRosterStore.getState().refresh("thread-1"); });
    expect(screen.getByRole("status")).toHaveTextContent("Stopped");
    expect(transport.loadSubagentDetail.mock.calls).toEqual([
      ["thread-1", "call:Inspect UI"], ["thread-1", "call:Inspect UI"],
    ]);
  });

  it("offers Retry after an error and retains the last good rows", async () => {
    transport.loadSubagentRoster.mockResolvedValueOnce(roster([row("Inspect UI")]))
      .mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce(roster([row("Inspect UI", "done")], 2));
    render(<SubagentsPanel threadId="thread-1" />);
    await screen.findByRole("button", { name: "Open Inspect UI details, Running" });
    await act(async () => { await useSubagentRosterStore.getState().refresh("thread-1"); });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load subagents");
    expect(screen.getByTestId("subagent-active-row")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Open Inspect UI details, Done" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
