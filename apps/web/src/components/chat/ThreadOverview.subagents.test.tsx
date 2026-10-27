import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import type { SubagentRosterEntry } from "@mcode/contracts";

vi.mock("@/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/transport")>()),
  getTransport: () => mockTransport,
}));

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/features/projects/state/workspaceStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockWorkspaceStoreModule(),
);

vi.mock("@/stores/diffStore", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockDiffStoreModule(
    await importOriginal<typeof import("@/stores/diffStore")>(),
  ),
);

vi.mock("@/stores/threadStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockThreadStoreModule(),
);

vi.mock("@/features/subagents", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockSubagentsModule(
    await importOriginal<typeof import("@/features/subagents")>(),
  ),
);

vi.mock("@/components/ui/dialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockDialogModule(),
);

vi.mock("./CreatePrDialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockCreatePrDialogModule(),
);

import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { mockOpenSubagentsPanel, mockThreadRecords } from "./__tests__/thread-overview-mocks";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

function rosterEntry(id: string, overrides: Partial<SubagentRosterEntry> = {}): SubagentRosterEntry {
  return { id: `call:${id}`, provider: "codex", title: id, prompt: null, subagentType: null, model: null, reasoningEffort: null,
    stepCount: 0, status: "done", startedAt: "2026-10-10T10:00:00.000Z", endedAt: null,
    tier: "transcript", canStop: false, sourceToolCallId: id, childThreadId: null,
    sourceMessageId: null, parentEntryId: null, ...overrides };
}

function seedSubagentRoster(threadId: string, entries: SubagentRosterEntry[]): void {
  useSubagentRosterStore.setState({
    rosters: new Map([[threadId, { owningParentThreadId: threadId, epoch: "test", revision: 1, entries, truncated: false }]]),
    errors: new Set(),
  });
}

describe("ThreadOverview subagents", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("shows a loaded sub-agent summary only when present and opens its panel", () => {
    const thread = branchlessThread();
    const first = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.queryByTestId("thread-overview-subagents")).not.toBeInTheDocument();
    first.unmount();

    seedSubagentRoster(thread.id, [rosterEntry("agent-1", { provider: "claude", status: "running" })]);
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const summary = screen.getByTestId("thread-overview-subagents");
    expect(summary).toHaveAccessibleName("Subagents, 1 active, 0 done");
    expect(summary).toHaveTextContent("1 active · 0 done");
    expect(summary).not.toHaveTextContent("total");
    expect(summary.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(1);
    expect(screen.queryByTestId("thread-overview-subagents-running")).not.toBeInTheDocument();
    expect(summary.querySelector('[data-provider-icon="claude"]')).toBeInTheDocument();
    fireEvent.click(summary);
    expect(mockOpenSubagentsPanel).toHaveBeenCalledOnce();
  });

  it("renders the sub-agent summary in Activity, above the Usage summary", () => {
    const thread = branchlessThread();
    seedSubagentRoster(thread.id, [rosterEntry("agent-1", { provider: "claude", status: "running" })]);
    mockThreadRecords.set(thread.id, {
      ...createEmptyThreadRecord(),
      usageByProvider: {
        claude: {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "ready-empty",
        },
      },
    });

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const usage = screen.getByTestId("thread-overview-usage");
    const subagents = screen.getByTestId("thread-overview-subagents");
    expect(usage.compareDocumentPosition(subagents) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
  });

  it("bounds the disc stack to three, lets the text carry the total, and omits the zero active count", () => {
    const thread = branchlessThread();
    seedSubagentRoster(thread.id, Array.from({ length: 8 }, (_, index) => rosterEntry(`agent-${index}`)));

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const summary = screen.getByTestId("thread-overview-subagents");
    expect(summary).toHaveAccessibleName("Subagents, 0 active, 8 done");
    expect(summary).toHaveTextContent("8 done");
    expect(summary).not.toHaveTextContent("active");
    expect(summary.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(3);
  });

  it("counts failed and stopped entries as done", () => {
    const thread = branchlessThread();
    seedSubagentRoster(thread.id, [
      rosterEntry("failed", { status: "failed" }),
      rosterEntry("stopped", { provider: "claude", status: "stopped" }),
      rosterEntry("running", { status: "running" }),
    ]);

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    expect(screen.getByTestId("thread-overview-subagents")).toHaveAccessibleName("Subagents, 1 active, 2 done");
  });
});
