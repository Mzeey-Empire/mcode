import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentsPanel } from "../SubagentsPanel";

const transport = vi.hoisted(() => ({ loadSubagentRoster: vi.fn(), stopCanonicalSubagent: vi.fn() }));
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => transport,
}));

function child(id: string): SubagentRosterEntry {
  return { id: `call:${id}`, provider: "codex", title: id, prompt: null, subagentType: null, model: null,
    stepCount: 0, status: "running", startedAt: "2026-10-10T10:00:00.000Z", endedAt: null,
    tier: "transcript", canStop: true, sourceToolCallId: id, childThreadId: `child-${id}`,
    sourceMessageId: null, parentEntryId: null };
}

describe("SubagentsPanel stop controls", () => {
  beforeEach(() => {
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    useDiffStore.setState({ subagentDetailByThread: {} });
    transport.stopCanonicalSubagent.mockReset().mockResolvedValue({ childThreadId: "child-one", status: "interrupted" });
    transport.loadSubagentRoster.mockReset().mockResolvedValue({
      owningParentThreadId: "parent", epoch: "stop-boot", revision: 1, entries: [child("one"), child("two")], truncated: false,
    });
  });

  it("sends exact child ids for Stop all and refreshes after stopping", async () => {
    render(<SubagentsPanel threadId="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("one");
    expect(dialog).toHaveTextContent("two");
    const buttons = screen.getAllByRole("button", { name: /Stop all/ });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(transport.stopCanonicalSubagent.mock.calls).toEqual([
      ["parent", "child-one"], ["parent", "child-two"],
    ]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not stop children when the confirmation is cancelled", async () => {
    render(<SubagentsPanel threadId="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(transport.stopCanonicalSubagent).not.toHaveBeenCalled();
  });

  it("does not select a child or issue duplicate Stop commands while stopping", async () => {
    let resolveStop: ((value: { childThreadId: string; status: "interrupted" }) => void) | undefined;
    transport.stopCanonicalSubagent.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve; }));
    render(<SubagentsPanel threadId="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop one" }));
    const pending = screen.getByRole("button", { name: "Stopping one" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(transport.stopCanonicalSubagent.mock.calls).toEqual([["parent", "child-one"]]);
    expect(useDiffStore.getState().subagentDetailByThread["parent"]).toBeUndefined();
    await act(async () => { resolveStop?.({ childThreadId: "child-one", status: "interrupted" }); });
  });

  it("keeps failed targets open and retries only those targets", async () => {
    transport.stopCanonicalSubagent.mockResolvedValueOnce({ childThreadId: "child-one", status: "interrupted" })
      .mockResolvedValueOnce({ childThreadId: "child-two", status: "failed" })
      .mockResolvedValueOnce({ childThreadId: "child-two", status: "interrupted" });
    render(<SubagentsPanel threadId="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(transport.stopCanonicalSubagent.mock.calls).toEqual([
      ["parent", "child-one"], ["parent", "child-two"], ["parent", "child-two"],
    ]);
  });

  it("freezes Stop-all targets while newer pushes add a child", async () => {
    render(<SubagentsPanel threadId="parent" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    transport.loadSubagentRoster.mockResolvedValue({
      owningParentThreadId: "parent", epoch: "stop-boot", revision: 2,
      entries: [child("one"), child("two"), child("three")], truncated: false,
    });
    await act(async () => { await useSubagentRosterStore.getState().refresh("parent"); });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("three")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(transport.stopCanonicalSubagent.mock.calls).toEqual([["parent", "child-one"], ["parent", "child-two"]]);
  });
});
