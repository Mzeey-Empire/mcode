import { createMockThread, createMockWorkspace, mockTransport } from "@/__tests__/mocks/transport";
import { ThreadOverview } from "@/components/chat/ThreadOverview";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOverviewEntries,
  getOverviewHeaderActions,
  OVERVIEW_ENTRIES,
  OVERVIEW_HEADER_ACTIONS,
} from "../overview-registry";
import type { OverviewSubject } from "../overview-subject";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

describe("overview registry", () => {
  const thread = createMockThread({ id: "overview-thread", workspace_id: "overview-workspace", provider: "cursor" });
  const subject: OverviewSubject = { kind: "thread", thread };

  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: thread.workspace_id })],
      threads: [thread],
      prUrlsByThreadId: {},
      checksById: {},
    });
    useOverviewStore.setState({ reserveThreadId: null, requestedThreadId: null });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useThreadStore.setState({ records: new Map([[thread.id, createEmptyThreadRecord()]]) });
  });

  it("orders thread entries globally, retaining section metadata for the later shell", () => {
    expect(getOverviewEntries(subject).map(({ id, section, order }) => [id, section, order])).toEqual([
      ["setup", "lane", 0],
      ["save-recovery", "activity", 10],
      ["changes", "activity", 20],
      ["repository", "activity", 30],
      ["plans", "activity", 40],
      ["local", "lane", 50],
      ["create-branch", "lane", 60],
      ["branch", "lane", 70],
      ["commit", "lane", 80],
      ["usage", "summary", 90],
      ["subagents", "activity", 100],
      ["pull-request", "lane", 110],
      ["browser", "activity", 120],
      ["sources", "activity", 130],
      ["recap", "summary", 140],
    ]);
    expect(getOverviewHeaderActions(subject).map(({ id }) => id)).toEqual(["project-actions", "settings"]);
  });

  it("excludes every existing entry and header action from a new-thread subject", () => {
    const newThread: OverviewSubject = { kind: "new-thread", workspaceId: thread.workspace_id };
    expect(getOverviewEntries(newThread).map(({ id }) => id)).toEqual([]);
    expect(getOverviewHeaderActions(newThread).map(({ id }) => id)).toEqual([]);
    const { container } = render(<>
      {OVERVIEW_ENTRIES.map(({ id, Entry }) => <Entry key={id} subject={newThread} />)}
      {OVERVIEW_HEADER_ACTIONS.map(({ id, Action }) => <Action key={id} subject={newThread} />)}
    </>);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the direct-thread rows in their existing DOM order without empty-row separators", async () => {
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await waitFor(() => expect(mockTransport.getRemoteUrl).toHaveBeenCalledWith(thread.workspace_id, thread.id));
    const body = screen.getByTestId("thread-overview-body");
    const rowIds = Array.from(body.querySelectorAll("[data-testid]"), element => element.getAttribute("data-testid"))
      .filter(id => ["thread-overview-masthead", "thread-overview-masthead-controls", "workspace-menu-changes", "thread-overview-local", "workspace-menu-branch", "thread-overview-recap"].includes(id ?? ""));
    expect(rowIds).toEqual([
      "thread-overview-masthead", "thread-overview-masthead-controls", "workspace-menu-changes",
      "thread-overview-local", "workspace-menu-branch", "thread-overview-recap",
    ]);
    expect(screen.queryByTestId("thread-overview-pr-separator")).not.toBeInTheDocument();
    expect(body.querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
  });
});
