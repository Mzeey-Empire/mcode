import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentDetail, SubagentRoster, SubagentRosterEntry } from "@mcode/contracts";
import { useMessageRevealStore } from "@/features/conversation/messages/message-reveal-store";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentDetailTab } from "../SubagentDetailTab";

const transport = vi.hoisted(() => ({ loadSubagentRoster: vi.fn(), loadSubagentDetail: vi.fn(), stopCanonicalSubagent: vi.fn() }));
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => transport,
}));

function entry(overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return {
    id: "call:explore", provider: "codex", title: "Explore", prompt: "Map the rail",
    subagentType: null, model: null, stepCount: 0, status: "done",
    startedAt: "2026-10-13T10:00:00.000Z", endedAt: "2026-10-13T10:00:09.000Z", tier: "steps", canStop: false,
    sourceToolCallId: "explore", childThreadId: null, sourceMessageId: "message-7", parentEntryId: null,
    ...overrides,
  };
}

function roster(entries: SubagentRosterEntry[], revision = 1): SubagentRoster {
  return { owningParentThreadId: "thread-1", epoch: "detail-boot", revision, entries, truncated: false };
}

function detail(overrides: Partial<SubagentDetail> = {}): SubagentDetail {
  return { entryId: "call:explore", totalSteps: 0, steps: [], summary: null, ...overrides };
}

async function renderTab(rows: SubagentRosterEntry[]) {
  useSubagentRosterStore.setState({ rosters: new Map([["thread-1", roster(rows)]]), errors: new Set() });
  await act(async () => { render(<SubagentDetailTab threadId="thread-1" entryId="call:explore" />); });
}

describe("SubagentDetailTab", () => {
  beforeEach(() => {
    useMessageRevealStore.setState({ request: null });
    transport.loadSubagentRoster.mockReset();
    transport.loadSubagentDetail.mockReset();
  });

  it("shows a steps-tier entry's steps, truncation, summary, and what the provider shares", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail({
      totalSteps: 12,
      steps: [{ toolCallId: "t1", toolName: "Read", label: "ActivityRail.tsx", status: "done", additions: 3, deletions: 1 }],
      summary: "The rail groups tools.",
    }));
    await renderTab([entry()]);

    expect(await screen.findByText("Showing the last 1 of 12 steps.")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-step")).toHaveTextContent("ReadActivityRail.tsx+3 −1");
    expect(screen.getByText("The rail groups tools.")).toBeInTheDocument();
    expect(screen.getByText("Codex shares its steps and a summary, not the full conversation.")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-parent-prompt")).toHaveTextContent("Map the rail");
  });

  it("says no steps were recorded only after a finished entry recorded none", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail());
    await renderTab([entry()]);
    expect(await screen.findByText("No steps were recorded.")).toBeInTheDocument();
  });

  it("explains a meta-tier entry and reveals the reply that carries its result", async () => {
    await renderTab([entry({ provider: "cursor", tier: "meta" })]);

    expect(screen.getByText(
      "Cursor doesn't share this subagent's steps or answer. Its result is in the reply that followed.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in chat" }));
    expect(useMessageRevealStore.getState().request).toEqual({ threadId: "thread-1", messageId: "message-7" });
    expect(transport.loadSubagentDetail).not.toHaveBeenCalled();
  });

  it("fills in a prompt that arrives after the tab opened", async () => {
    await renderTab([entry({ provider: "cursor", tier: "meta", prompt: null })]);
    expect(screen.queryByTestId("subagent-parent-prompt")).toBeNull();

    act(() => useSubagentRosterStore.setState({
      rosters: new Map([["thread-1", roster([entry({ provider: "cursor", tier: "meta", prompt: "Audit the rail" })], 2)]]),
    }));
    expect(screen.getByTestId("subagent-parent-prompt")).toHaveTextContent("Audit the rail");
  });

  it("reloads steps when the roster revision moves", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail());
    await renderTab([entry({ status: "running", endedAt: null })]);
    await act(async () => useSubagentRosterStore.setState({
      rosters: new Map([["thread-1", roster([entry()], 2)]]),
    }));
    expect(transport.loadSubagentDetail.mock.calls).toEqual([
      ["thread-1", "call:explore"], ["thread-1", "call:explore"],
    ]);
  });

  it("says the subagent is gone once its entry leaves the roster", async () => {
    await renderTab([]);
    expect(screen.getByTestId("subagent-detail-missing")).toHaveTextContent("This subagent is no longer available.");
  });
});
