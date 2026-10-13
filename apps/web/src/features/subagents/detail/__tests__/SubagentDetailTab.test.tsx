import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  createAgentModelState, type AgentItem, type AgentTurn, type Message, type SubagentDetail, type SubagentRoster, type SubagentRosterEntry,
} from "@mcode/contracts";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { useMessageRevealStore } from "@/features/conversation/messages/message-reveal-store";
import { useSubagentRosterStore } from "../../state/subagentRosterStore";
import { SubagentDetailTab } from "../SubagentDetailTab";

const transport = vi.hoisted(() => ({ loadSubagentRoster: vi.fn(), loadSubagentDetail: vi.fn(), stopCanonicalSubagent: vi.fn() }));
vi.mock("@/features/conversation", async (original) => ({
  ...await original<typeof import("@/features/conversation")>(),
  getConversationResidency: () => ({ mountDisplayConversation: () => {}, unmountDisplayConversation: () => {} }),
  MessageList: ({ leadingContent }: { readonly leadingContent?: ReactNode }) => <div data-testid="child-transcript">{leadingContent}</div>,
}));
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

/** A live child whose opening prompt exists only as a canonical item, as before history hydrates. */
function seedLiveChild(prompt: string) {
  const timestamp = "2026-10-13T10:00:00.000Z";
  const message: Message = {
    id: "child-prompt", thread_id: "child-1", role: "user", content: prompt, tool_calls: null, files_changed: null,
    cost_usd: null, tokens_used: null, timestamp, sequence: 1, attachments: null,
  };
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

  it("says the subagent is gone once its entry leaves the roster", async () => {
    await renderTab([]);
    expect(screen.getByTestId("subagent-detail-missing")).toHaveTextContent("This subagent is no longer available.");
  });
});
