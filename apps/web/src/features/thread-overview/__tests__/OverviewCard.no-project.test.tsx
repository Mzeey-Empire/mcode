import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { ThreadOverview } from "@/components/chat/ThreadOverview";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOverviewEntries } from "../overview-registry";
import type { OverviewSubject } from "../overview-subject";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const FOLDER = "/home/user/.mcode/no-project/abc123";
const noProjectWorkspace = createMockWorkspace({ id: "ws-hidden", name: "No project", kind: "no_project", is_git_repo: false, path: FOLDER });
const projectWorkspace = createMockWorkspace({ id: "ws-project", name: "mcode", path: "/work/mcode", is_git_repo: true });

function seed(workspace: typeof noProjectWorkspace) {
  const thread = createMockThread({ id: `thread-${workspace.id}`, workspace_id: workspace.id, mode: "direct", worktree_path: null, provider: "cursor" });
  useWorkspaceStore.setState({ workspaces: [workspace], threads: [thread], prUrlsByThreadId: {}, checksById: {} });
  useThreadStore.setState({ records: new Map([[thread.id, createEmptyThreadRecord()]]), recapByThread: {} });
  return thread;
}

async function openCard(thread: ReturnType<typeof seed>) {
  render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
  const card = await screen.findByTestId("thread-overview-card");
  return card;
}

describe("Overview card for a No project thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockTransport.getRemoteUrl).mockReset().mockResolvedValue({ label: "mcode", webUrl: null });
    useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {}, snapshotsByThread: {}, diffRevisionByScope: {} });
  });

  it("shows the folder the thread works in and none of the project or git rows", async () => {
    const card = await openCard(seed(noProjectWorkspace));

    const folder = within(card).getByTestId("thread-overview-folder");
    expect(within(folder).getByTestId("thread-overview-folder-path")).toHaveTextContent(FOLDER);
    expect(within(card).queryByRole("button", { name: "Open Project settings" })).toBeNull();
    expect(mockTransport.getRemoteUrl).not.toHaveBeenCalled();
    expect(mockTransport.getReviewComparison).not.toHaveBeenCalled();
    expect(mockTransport.readWorkspaceEnvironment).not.toHaveBeenCalled();
  });

  // One test per row, so a row that comes back fails under its own name. The PR row renders only once a PR exists,
  // so the registry test below guards it instead.
  it.each([
    "thread-overview-local",
    "workspace-menu-branch",
    "workspace-menu-changes",
    "thread-overview-project-actions",
    "thread-overview-repository",
  ])("shows no %s row", async (testId) => {
    const card = await openCard(seed(noProjectWorkspace));

    expect(within(card).queryByTestId(testId)).toBeNull();
  });

  it("opens the folder in the file manager and copies its path", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const card = await openCard(seed(noProjectWorkspace));

    await user.click(within(card).getByRole("button", { name: "Open folder" }));
    expect(mockTransport.openIn).toHaveBeenCalledWith("explorer", FOLDER);
    await user.click(within(card).getByRole("button", { name: "Copy folder path" }));
    expect(writeText).toHaveBeenCalledWith(FOLDER);
  });

  it("leaves a project thread's card as it was, with project settings and no folder row", async () => {
    const card = await openCard(seed(projectWorkspace));

    expect(within(card).getByTestId("thread-overview-local")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Open Project settings" })).toBeInTheDocument();
    expect(within(card).queryByTestId("thread-overview-folder")).toBeNull();
  });

  const registeredIds = (noProject: boolean) =>
    getOverviewEntries({ kind: "thread", thread: createMockThread() } satisfies OverviewSubject, noProject).map(({ id }) => id);

  it("registers the Folder row only for a No project thread", () => {
    expect(registeredIds(true)).toContain("folder");
    expect(registeredIds(false)).not.toContain("folder");
    for (const kept of ["terminals", "usage", "plan", "subagents", "background-commands", "browser", "recap"]) {
      expect(registeredIds(true)).toContain(kept);
    }
  });

  it.each(["local", "branch", "git", "changes", "repository", "pull-request", "project-actions"])(
    "registers the %s entry for a project thread only",
    (id) => {
      expect(registeredIds(false)).toContain(id);
      expect(registeredIds(true)).not.toContain(id);
    },
  );
});
