import { createMockMessage } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createAgentModelState, type AgentItem, type AgentTurn } from "@mcode/contracts/compat/agent-model";
import { type Message } from "@mcode/contracts/models/message";
import { type SubagentDetail, type SubagentRoster, type SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { useMessageRevealStore } from "@/features/conversation/messages/message-reveal-store";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentDetailTab } from "../SubagentDetailTab";

const transport = {
  loadSubagentRoster: vi.mocked(mockTransport.loadSubagentRoster),
  loadSubagentDetail: vi.mocked(mockTransport.loadSubagentDetail),
  stopCanonicalSubagent: vi.mocked(mockTransport.stopCanonicalSubagent),
};
vi.mock("@/features/conversation", async (original) => ({
  ...await original<typeof import("@/features/conversation")>(),
  getConversationResidency: () => ({ mountDisplayConversation: () => {}, unmountDisplayConversation: () => {} }),
  MessageList: ({ leadingContent }: { readonly leadingContent?: ReactNode }) => <div data-testid="child-transcript">{leadingContent}</div>,
}));
vi.mock("@/transport", async (original) => ({
  ...await original<typeof import("@/transport")>(), getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.loadSubagentRoster).mockReset();
  vi.mocked(mockTransport.loadSubagentDetail).mockReset();
  vi.mocked(mockTransport.stopCanonicalSubagent).mockReset();
});

function entry(overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return {
    id: "call:explore", provider: "codex", title: "Explore", prompt: "Map the rail",
    subagentType: null, model: null, reasoningEffort: null, stepCount: 0, status: "done",
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

/** A live child whose opening prompt exists only as a canonical item, as before history hydrates. */
function seedLiveChild(prompt: string) {
  const timestamp = "2026-10-13T10:00:00.000Z";
  const message: Message = createMockMessage({
    id: "child-prompt",
    thread_id: "child-1",
    role: "user",
    content: prompt,
    timestamp,
    sequence: 1,
  });
  const turn: AgentTurn = {
    id: "child-turn", threadId: "child-1", status: "Running",
    trigger: { kind: "child", sourceThreadId: "thread-1", sourceTurnId: "parent-turn" },
    permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null,
    providerIdentities: [], startedAt: timestamp, providerStartedAt: null, ending: null, endedAt: null,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const item: AgentItem = {
    id: "child-prompt-item", threadId: "child-1", turnId: turn.id, kind: "message", providerIdentities: [],
    payload: { projection: "message", message }, createdAt: timestamp, updatedAt: timestamp,
  };
  const state = createAgentModelState();
  state.turns[turn.id] = turn;
  state.items[item.id] = item;
  const record = createEmptyThreadRecord();
  useThreadStore.setState({ records: new Map([["child-1", { ...record, canonicalAgent: { ...record.canonicalAgent, state } }]]) });
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a steps-tier entry's steps, truncation, and its report as the reply", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail({
      totalSteps: 12,
      steps: [
        { toolCallId: "t1", toolName: "Read", label: "ActivityRail.tsx", status: "done", additions: 3, deletions: 1 },
        { toolCallId: "t2", toolName: "Edit", label: "RightPanel.tsx", status: "done", additions: 4, deletions: 0 },
      ],
      summary: "# Rail\n\nThe rail groups tools.",
    }));
    await renderTab([entry()]);

    expect(await screen.findByText("Showing the last 2 of 12 steps.")).toBeInTheDocument();
    const [read, edit] = screen.getAllByTestId("subagent-step");
    expect(read).toHaveTextContent("ReadActivityRail.tsx+3−1");
    expect(edit).toHaveTextContent("EditedRightPanel.tsx+4");
    expect(await screen.findByRole("heading", { name: "Rail" })).toBeInTheDocument();
    expect(screen.getByTestId("subagent-reply")).toHaveTextContent("The rail groups tools.");
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/shares its steps/)).not.toBeInTheDocument();
    expect(screen.getByTestId("subagent-parent-prompt")).toHaveTextContent("Map the rail");
  });

  it("labels the agent, model, and effort the way the composer does, and leaves out what was not reported", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail());
    await renderTab([entry({ subagentType: "Hubble", model: "gpt-5.6-sol", reasoningEffort: "xhigh" })]);
    expect(screen.getByTestId("subagent-detail-meta")).toHaveTextContent(/^Hubble · GPT-5\.6 Sol X-High9s$/);

    cleanup();
    await renderTab([entry({ provider: "claude" })]);
    expect(screen.getByTestId("subagent-detail-meta")).toHaveTextContent(/^9s$/);
  });

  it("says no steps were recorded only after a finished entry recorded none", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail());
    await renderTab([entry()]);
    expect(await screen.findByText("No steps were recorded.")).toBeInTheDocument();
  });

  it("explains a meta-tier entry and reveals the reply that carries its result", async () => {
    setLayoutMeasurements(1200, 1200);
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useUiStore.setState({ rightPanelMaximized: true, rightPanelMaximizedByLayout: false });
    await renderTab([entry({ provider: "cursor", tier: "meta" })]);

    expect(screen.getByText(
      "Cursor doesn't share this subagent's steps or answer. Its result is in the reply that followed.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in chat" }));
    expect(useMessageRevealStore.getState().request).toEqual({ threadId: "thread-1", messageId: "message-7" });
    expect(useUiStore.getState().rightPanelMaximized).toBe(false);
    expect(transport.loadSubagentDetail).not.toHaveBeenCalled();
  });

  it("goes back to the Subagents list and keeps the detail tab open", async () => {
    transport.loadSubagentDetail.mockResolvedValue(detail());
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.getState().openSubagentTab("workspace-1", "thread-1", "call:explore");
    await renderTab([entry()]);

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    const panel = useDiffStore.getState().getRightPanel("workspace-1", "thread-1");
    expect(panel.activeTabId).toBe("singleton:subagents");
    expect(panel.tabInstances.map((tab) => tab.id)).toContain("subagent:call:explore");
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

  it("shows the parent's prompt above a transcript only when the child does not open with it", async () => {
    const transcriptEntry = entry({ provider: "claude", tier: "transcript", childThreadId: "child-1", status: "running", endedAt: null });
    seedLiveChild("Map the rail");
    await renderTab([transcriptEntry]);
    expect(screen.getByTestId("child-transcript")).toBeEmptyDOMElement();

    act(() => seedLiveChild("Something else"));
    expect(screen.getByTestId("subagent-parent-prompt")).toHaveTextContent("Map the rail");
  });

  it("offers Show all once a narrower panel makes the prompt overflow", async () => {
    class ManualResizeObserver implements ResizeObserver {
      static readonly all: ManualResizeObserver[] = [];
      target: Element | null = null;
      constructor(readonly callback: ResizeObserverCallback) { ManualResizeObserver.all.push(this); }
      observe(target: Element) { this.target = target; }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ManualResizeObserver);
    let scrollHeight = 100;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(132);
    await renderTab([entry({ provider: "cursor", tier: "meta" })]);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();

    scrollHeight = 200;
    const prompt = screen.getByTestId("subagent-parent-prompt");
    act(() => ManualResizeObserver.all.filter((observer) => observer.target === prompt)
      .forEach((observer) => observer.callback([], observer)));
    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
  });

  it("says the subagent is gone once its entry leaves the roster", async () => {
    await renderTab([]);
    expect(screen.getByTestId("subagent-detail-missing")).toHaveTextContent("This subagent is no longer available.");
  });
});
