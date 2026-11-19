import { createMockApproval, createMockThreadAttention } from "@mcode/contracts/testing";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useApprovalStore } from "@/stores/approvalStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useMessageListData } from "../../messages/useMessageListData";
import { useMessageListItems } from "../../messages/useMessageListItems";
import { ApprovalDock, useDelegatedThreadTitles, useDockApprovals } from "../ApprovalDock";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const PARENT = "parent";
const CHILD = "child";
const NO_FOLDS = new Set<string>();

function childEntry(): SubagentRosterEntry {
  return { id: "thread:child", provider: "claude", title: "Fix login", prompt: null, subagentType: null, model: null,
    reasoningEffort: null, stepCount: 0, status: "needs-you", startedAt: "2026-10-10T10:00:00.000Z", endedAt: null,
    tier: "transcript", canStop: false, sourceToolCallId: "delegate", sourceMessageId: "message", childThreadId: CHILD, parentEntryId: null };
}

function ParentView() {
  const composerRef = useRef<HTMLDivElement>(null);
  const delegatedThreads = useDelegatedThreadTitles(PARENT);
  const requests = useDockApprovals(PARENT, delegatedThreads);
  const data = useMessageListData(PARENT);
  const { items } = useMessageListItems({ ...data, expandedFolds: NO_FOLDS, expandedGroups: NO_FOLDS });
  const indicator = items.find((item) => item.type === "narrative-indicator");
  return (
    <>
      <p data-testid="indicator">{indicator?.type === "narrative-indicator" ? `${indicator.status.label}|${indicator.status.icon}` : ""}</p>
      {requests.length > 0 && (
        <ApprovalDock requests={requests} delegatedThreads={delegatedThreads} composerContainerRef={composerRef}
          isAgentRunning={false} isStopPending={false} onStop={() => {}} onFocusComposer={() => {}} />
      )}
      <div ref={composerRef} />
    </>
  );
}

beforeEach(() => {
  resetThreadStoreForTests({ records: new Map([[PARENT, createEmptyThreadRecord()]]) });
  useApprovalStore.setState({ approvals: [], submissions: {} });
  useSubagentRosterStore.setState({ loads: new Map([[PARENT, { kind: "ready", roster: {
    owningParentThreadId: PARENT, epoch: "boot", revision: 1, entries: [childEntry()], truncated: false,
  } }]]) });
  threadAttentionStore.setState({ byThreadId: { [PARENT]: createMockThreadAttention({ threadId: PARENT, descendants: "needs-you" }) } });
});

afterEach(() => {
  resetThreadStoreForTests();
  useSubagentRosterStore.setState({ loads: new Map() });
  threadAttentionStore.setState({ byThreadId: {} });
});

describe("a parent whose subagent waits on approval", () => {
  it("shows the child's approval in its dock and says so in its timeline", () => {
    act(() => useApprovalStore.getState().add(createMockApproval({ requestId: "child-req", threadId: CHILD })));
    render(<ParentView />);

    expect(screen.getByText("From Fix login")).toBeInTheDocument();
    expect(screen.getByTestId("indicator")).toHaveTextContent("Subagent needs you|layers");
  });
});
