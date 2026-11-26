import { createMockMessage, createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import type { DetachedWorktreeTarget, GitRef, GitRefsListParams, GitRefsListResult } from "@mcode/contracts/git";
import type { PullRequestTarget } from "@mcode/contracts/github";
import type { ThreadMovePreflight, ThreadMoveResult } from "@mcode/contracts/ws/methods";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";
import { useSidebarUiStore } from "../../sidebar/sidebar-ui-store";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { MoveThreadDialogHost } from "../MoveThreadDialog";
import { closeMoveThreadDialog, openMoveThreadDialog } from "../move-thread-store";
import { installListboxLayout } from "@/__tests__/helpers/picker-layout";
import { invalidateBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { rememberStartFromOrigin } from "@/lib/start-from-origin-preference";

installListboxLayout();

const ALPHA = createMockWorkspace({ id: "ws-alpha", name: "alpha", path: "/work/alpha", is_git_repo: false });
const BETA = createMockWorkspace({ id: "ws-beta", name: "beta", path: "/work/beta", is_git_repo: false });
const GIT_PROJECT = createMockWorkspace({ id: "ws-git", name: "gitty", path: "/work/gitty", is_git_repo: true });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });
const THREAD = createMockThread({ id: "t-1", title: "SQLite WAL vs rollback journal", workspace_id: HIDDEN.id });

type RefusedMove = Exclude<ThreadMoveResult, { status: "moved" }>;

function movedTo(workspaceId: string): ThreadMoveResult {
  return { status: "moved", thread: { ...THREAD, workspace_id: workspaceId } };
}

function noFiles(): ThreadMovePreflight {
  return { hasFiles: false, otherThreadsInFolder: { count: 0, titles: [] }, deadline: new Date(2026, 11, 3, 12).toISOString() };
}

function seed(): void {
  useWorkspaceStore.setState({
    workspaces: [ALPHA, BETA, GIT_PROJECT, HIDDEN],
    workspacesLoaded: true,
    threads: [THREAD],
    activeThreadId: THREAD.id,
    activeWorkspaceId: HIDDEN.id,
    pendingNewThread: false,
  });
}

function dialog(): Promise<HTMLElement> {
  return screen.findByRole("dialog", { name: /^Move to / });
}

async function openDialog(): Promise<UserEvent> {
  const user = userEvent.setup();
  render(<MoveThreadDialogHost />);
  act(() => openMoveThreadDialog(THREAD.id));
  await dialog();
  return user;
}

async function pickProject(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByTestId("new-thread-project-slot"));
  await user.click(await screen.findByRole("option", { name }));
}

function moveButton(): HTMLElement {
  return screen.getByRole("button", { name: /^(Move thread|Try again|Moving…)$/ });
}

describe("MoveThreadDialog", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    seed();
    vi.mocked(mockTransport.moveThreadToProject).mockReset().mockResolvedValue(movedTo(ALPHA.id));
    vi.mocked(mockTransport.readThreadMovePreflight).mockReset().mockResolvedValue(noFiles());
  });

  afterEach(() => {
    cleanup();
    closeMoveThreadDialog();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("asks where to move the thread, which one it is, and offers nothing until a project is picked", async () => {
    await openDialog();

    const open = await dialog();
    expect(within(open).getByRole("heading", { name: "Move to a project" })).toBeVisible();
    expect(open).toHaveTextContent("SQLite WAL vs rollback journal");
    expect(moveButton()).toBeDisabled();
    expect(screen.queryByTestId("move-target-rail")).toBeNull();
  });

  it("picks among projects only, shows the Local rail, and leaves the composer alone", async () => {
    const user = await openDialog();

    await user.click(screen.getByTestId("new-thread-project-slot"));
    expect(await screen.findAllByRole("option")).toEqual(["alpha", "beta", "gitty"].map((name) => screen.getByRole("option", { name })));
    await user.click(screen.getByRole("option", { name: "beta" }));

    expect(screen.getByRole("heading", { name: "Move to beta" })).toBeVisible();
    expect(within(screen.getByTestId("move-target-rail")).getByTestId("workspace-target-trigger")).toHaveTextContent("Local");
    expect(moveButton()).toBeEnabled();
    expect(useWorkspaceStore.getState().pendingNewThread).toBe(false);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(HIDDEN.id);
  });

  it("names the branch the thread will run on for a git project", async () => {
    const main: GitRef = {
      kind: "ref", fullName: "refs/heads/main", shortName: "main", branchName: "main", remote: null, twin: null,
      isCurrent: true, isDefault: true, worktree: null, headSha: "a".repeat(40), committedAt: "2026-10-01T12:00:00.000Z",
    };
    vi.mocked(mockTransport.listRefs).mockResolvedValueOnce({ ok: true, items: [main], total: 1, nextCursor: null });
    const user = await openDialog();

    await pickProject(user, "gitty");

    expect(await within(screen.getByTestId("move-target-rail")).findByText("On main")).toBeVisible();
  });

  it("moves the thread to the chosen project and closes", async () => {
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockTransport.moveThreadToProject).toHaveBeenCalledExactlyOnceWith({ threadId: THREAD.id, workspaceId: ALPHA.id, target: { kind: "local" } });
    expect(useWorkspaceStore.getState().threads[0]?.workspace_id).toBe(ALPHA.id);
    expect(useWorkspaceStore.getState().activeThreadId).toBe(THREAD.id);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ALPHA.id);
    expect(useSidebarUiStore.getState().expandedProjects.has(ALPHA.id)).toBe(true);
  });

  it("holds the dialog still while the move runs", async () => {
    let finish: (result: ThreadMoveResult) => void = () => {};
    vi.mocked(mockTransport.moveThreadToProject).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    expect(await screen.findByRole("button", { name: "Moving…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    expect(screen.getByTestId("new-thread-project-slot")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(await dialog()).toBeVisible();

    await act(async () => finish(movedTo(ALPHA.id)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    ["database-busy", "Mcode's database was busy, so nothing changed: the thread is still in No project and its files are untouched. Try again in a moment."],
    ["other", "Nothing changed: the thread is still in No project and its files are untouched. Try again in a moment."],
  ] as const)("explains a %s failure, discloses the raw error, and can retry", async (cause, detail) => {
    const raw = "The database write could not finish";
    vi.mocked(mockTransport.moveThreadToProject)
      .mockResolvedValueOnce({ status: "failed", cause, error: raw })
      .mockResolvedValueOnce(movedTo(ALPHA.id));
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't move the thread");
    expect(within(alert).getByText(detail)).toBeVisible();
    expect(screen.queryByText(raw)).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(screen.getByText(raw)).toBeVisible();
    expect(screen.getByTestId("move-target-rail")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockTransport.moveThreadToProject).toHaveBeenCalledTimes(2);
  });

  it.each<[RefusedMove, string]>([
    [{ status: "busy", reason: "running" }, "This thread is running."],
    [{ status: "busy", reason: "needs-approval" }, "This thread needs approval."],
    [{ status: "busy", reason: "background" }, "This thread has work running in the background."],
  ])("shows %j as the failed state with its cause", async (refusal, cause) => {
    vi.mocked(mockTransport.moveThreadToProject).mockResolvedValue(refusal);
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(cause);
    expect(alert).toHaveTextContent("Nothing changed: the thread is still in No project.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(useWorkspaceStore.getState().threads[0]?.workspace_id).toBe(HIDDEN.id);
  });

  it("asks for another project when the chosen one is gone, instead of retrying it", async () => {
    vi.mocked(mockTransport.moveThreadToProject).mockResolvedValue({ status: "destination-missing" });
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("That project is no longer in Mcode.");
    expect(screen.getByRole("heading", { name: "Move to a project" })).toBeVisible();
    expect(moveButton()).toHaveTextContent("Move thread");
    expect(moveButton()).toBeDisabled();
  });

  it("lets the user close an unconfirmed move without retrying", async () => {
    const raw = "Move commit reply lost";
    vi.mocked(mockTransport.moveThreadToProject).mockResolvedValue({ status: "unconfirmed", error: raw });
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't confirm the move");
    expect(alert).toHaveTextContent("Check the sidebar to see where the thread is.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText(raw)).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(screen.getByText(raw)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not claim nothing changed when the request never answered", async () => {
    vi.mocked(mockTransport.moveThreadToProject).mockRejectedValue(new Error("socket closed"));
    const user = await openDialog();
    await pickProject(user, "alpha");

    await user.click(moveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Mcode could not confirm the move.");
    expect(alert).not.toHaveTextContent("Nothing changed");
    await user.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(screen.getByText("socket closed")).toBeVisible();
  });

  it("closes when the thread has already left No project elsewhere", async () => {
    await openDialog();

    act(() => useWorkspaceStore.getState().applyThreadMovedToProject({ ...THREAD, workspace_id: BETA.id }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  describe("preflight read", () => {
    it("keeps Move disabled until the read answers", async () => {
      let answer: (preflight: ThreadMovePreflight) => void = () => {};
      vi.mocked(mockTransport.readThreadMovePreflight).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const user = await openDialog();
      await pickProject(user, "alpha");

      expect(moveButton()).toBeDisabled();

      await act(async () => answer(noFiles()));
      expect(moveButton()).toBeEnabled();
    });

    it("shows a notice and keeps Move disabled when the read fails, and Retry brings back the normal note", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight)
        .mockRejectedValueOnce(new Error("socket closed"))
        .mockResolvedValueOnce({ ...noFiles(), hasFiles: true });
      const user = await openDialog();
      await pickProject(user, "alpha");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't check this thread's folder. Try again.");
      expect(moveButton()).toBeDisabled();

      await user.click(within(alert).getByRole("button", { name: "Retry" }));

      expect(await screen.findByText(/^Old files deleted/)).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(moveButton()).toBeEnabled();
      expect(mockTransport.moveThreadToProject).not.toHaveBeenCalled();
    });

    it("treats a null read, which the server gives for a thread that cannot move, as a failed one", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight).mockResolvedValue(null);
      const user = await openDialog();
      await pickProject(user, "alpha");

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check this thread's folder.");
      expect(moveButton()).toBeDisabled();
    });

    it("keeps the notice and Move disabled when Retry fails again", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight).mockRejectedValue(new Error("socket closed"));
      const user = await openDialog();
      await pickProject(user, "alpha");

      await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Retry" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check this thread's folder.");
      expect(mockTransport.readThreadMovePreflight).toHaveBeenCalledTimes(2);
      expect(moveButton()).toBeDisabled();
    });
  });

  describe("old files note", () => {
    function filesPreflight(overrides: Partial<ThreadMovePreflight>): void {
      vi.mocked(mockTransport.readThreadMovePreflight).mockResolvedValue({ ...noFiles(), hasFiles: true, ...overrides });
    }

    it("gives the deletion date beside Move once a project is picked, and not before", async () => {
      filesPreflight({});
      const user = await openDialog();
      await waitFor(() => expect(mockTransport.readThreadMovePreflight).toHaveBeenCalled());
      expect(screen.queryByText(/Old files deleted/)).toBeNull();

      await pickProject(user, "alpha");

      const note = await screen.findByText(/^Old files deleted/);
      expect(note.textContent).toMatch(/^Old files deleted (3 Dec|Dec 3)$/);
    });

    it("says once unused while another thread still works in the folder", async () => {
      filesPreflight({ otherThreadsInFolder: { count: 1, titles: ["A fork"] } });
      const user = await openDialog();

      await pickProject(user, "alpha");

      expect(await screen.findByText("Old files deleted once unused")).toBeVisible();
    });

    it("says nothing when the old folder holds no files", async () => {
      const user = await openDialog();
      await waitFor(() => expect(mockTransport.readThreadMovePreflight).toHaveBeenCalled());

      await pickProject(user, "alpha");

      expect(screen.queryByText(/Old files deleted/)).toBeNull();
    });
  });
});

const OTHER_GIT_PROJECT = createMockWorkspace({ id: "ws-git-2", name: "gitty-two", path: "/work/gitty-two", is_git_repo: true });
const RETRY_WORKTREE = { path: "/work/gitty-wt/reconnect-retry", folder: "reconnect-retry" };
const REVIEW_WORKTREE = { path: "/work/gitty-wt/review", folder: "review" };

function ref(shortName: string, overrides: Partial<GitRef> = {}): GitRef {
  return {
    kind: "ref", fullName: `refs/heads/${shortName}`, shortName, branchName: shortName, remote: null, twin: null,
    isCurrent: false, isDefault: false, worktree: null, headSha: "a".repeat(40), committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function pullRequest(number: number, title: string, headRefName: string): PullRequestTarget {
  return { number, title, headRefName, author: "octo", isCrossRepository: false, url: `https://github.com/acme/app/pull/${number}` };
}

const BRANCHES: readonly GitRef[] = [
  ref("main", { isCurrent: true, isDefault: true }),
  ref("feat/reconnect-retry", { worktree: RETRY_WORKTREE }),
  ref("origin/fix/sidebar-fade", { branchName: "fix/sidebar-fade", remote: "origin", fullName: "refs/remotes/origin/fix/sidebar-fade" }),
];
const RETRY_PR = pullRequest(412, "Retry the websocket reconnect with backoff", "feat/reconnect-retry");

function pageOf<T>(items: readonly T[]) {
  return { ok: true as const, items: [...items], total: items.length, nextCursor: null };
}

describe("MoveThreadDialog worktree targets", () => {
  let worktreeRows: readonly (GitRef | DetachedWorktreeTarget)[] = [];

  function answerRefs(params: GitRefsListParams): GitRefsListResult {
    return pageOf(params.purpose === "existing-worktree" ? worktreeRows : BRANCHES);
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    useWorkspaceStore.setState({
      workspaces: [ALPHA, GIT_PROJECT, OTHER_GIT_PROJECT, HIDDEN],
      workspacesLoaded: true,
      threads: [THREAD],
      activeThreadId: THREAD.id,
      activeWorkspaceId: HIDDEN.id,
      pendingNewThread: false,
    });
    worktreeRows = [ref("feat/reconnect-retry", { worktree: RETRY_WORKTREE })];
    invalidateBranchTargets(GIT_PROJECT.id);
    invalidateBranchTargets(OTHER_GIT_PROJECT.id);
    vi.mocked(mockTransport.listRefs).mockReset().mockImplementation(async (params) => answerRefs(params));
    vi.mocked(mockTransport.listPullRequestTargets).mockReset().mockResolvedValue(pageOf([RETRY_PR]));
    vi.mocked(mockTransport.moveThreadToProject).mockReset().mockResolvedValue(movedTo(GIT_PROJECT.id));
    vi.mocked(mockTransport.readThreadMovePreflight).mockReset().mockResolvedValue(noFiles());
  });

  afterEach(() => {
    cleanup();
    closeMoveThreadDialog();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  const workspaceTrigger = () => screen.getByTestId("workspace-target-trigger");

  async function chooseMode(user: UserEvent, mode: "New worktree" | "Existing worktree"): Promise<void> {
    await user.click(workspaceTrigger());
    await user.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${mode}`) }));
  }

  async function openPicker(user: UserEvent): Promise<void> {
    await user.click(await screen.findByTestId("composer-branch-trigger"));
  }

  async function sentTarget(): Promise<unknown> {
    await waitFor(() => expect(mockTransport.moveThreadToProject).toHaveBeenCalledOnce());
    return vi.mocked(mockTransport.moveThreadToProject).mock.calls[0]?.[0].target;
  }

  it("moves into a new worktree from the project's branch, and leaves the new-thread draft alone", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");

    await chooseMode(user, "New worktree");

    expect(await screen.findByTestId("composer-branch-trigger")).toHaveTextContent("From main");
    expect(useWorkspaceStore.getState().newThreadMode).toBe("direct");
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "branch", baseBranch: "main", startFromOrigin: false } });
  });

  it("moves into a new worktree from the branch the user picked", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "New worktree");

    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /^feat\/reconnect-retry/ }));

    expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("From feat/reconnect-retry");
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "branch", baseBranch: "feat/reconnect-retry", startFromOrigin: false } });
  });

  it("starts from origin when the switch is on", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "New worktree");

    await openPicker(user);
    await user.click(await screen.findByText("Start from origin"));
    await user.keyboard("{Escape}");

    expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("From main (remote)");
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "branch", baseBranch: "main", startFromOrigin: true } });
  });

  it("starts from origin when the project's last new worktree thread did", async () => {
    rememberStartFromOrigin(GIT_PROJECT.id, true);
    try {
      const user = await openDialog();
      await pickProject(user, "gitty");
      await chooseMode(user, "New worktree");

      expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("From main (remote)");
      await user.click(moveButton());
      expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "branch", baseBranch: "main", startFromOrigin: true } });
    } finally {
      rememberStartFromOrigin(GIT_PROJECT.id, false);
    }
  });

  it("names a remote-only branch without its remote and always starts from origin", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "New worktree");

    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /^origin\/fix\/sidebar-fade/ }));

    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "branch", baseBranch: "fix/sidebar-fade", startFromOrigin: true } });
  });

  it("moves into a new worktree from a pull request with its number and head branch", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "New worktree");

    await openPicker(user);
    await user.click(await screen.findByRole("radio", { name: "Pull requests" }));
    await user.click(await screen.findByRole("option", { name: /Retry the websocket reconnect with backoff/ }));

    expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("From #412");
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "new-worktree", source: { kind: "pr", branch: "feat/reconnect-retry", pullRequestNumber: 412 } });
  });

  it("keeps Move disabled in Existing worktree until a worktree is picked, then moves into it", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");

    await chooseMode(user, "Existing worktree");

    expect(await screen.findByTestId("composer-branch-trigger")).toHaveTextContent("Choose a worktree");
    expect(moveButton()).toBeDisabled();

    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /^reconnect-retry/ }));

    expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("On feat/reconnect-retry");
    expect(moveButton()).toBeEnabled();
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "existing-worktree", worktreePath: RETRY_WORKTREE.path });
  });

  it("sends the base branch the user picked for a detached worktree", async () => {
    worktreeRows = [{ kind: "detached-worktree", worktree: REVIEW_WORKTREE, headShortSha: "abc1234" }];
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "Existing worktree");

    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /review/ }));

    expect(screen.getByTestId("composer-branch-trigger")).toHaveTextContent("review");
    expect(await screen.findByTestId("composer-base-branch-trigger")).toHaveTextContent("From main");
    await user.click(screen.getByTestId("composer-base-branch-trigger"));
    await user.click(await screen.findByRole("option", { name: /^feat\/reconnect-retry/ }));
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "existing-worktree", worktreePath: REVIEW_WORKTREE.path, baseBranch: "feat/reconnect-retry" });
  });

  it("disables Existing worktree as None yet when the project has no worktrees", async () => {
    worktreeRows = [];
    const user = await openDialog();
    await pickProject(user, "gitty");

    await user.click(workspaceTrigger());

    const row = await screen.findByRole("menuitemradio", { name: /^Existing worktree/ });
    await waitFor(() => expect(row).toHaveAttribute("aria-disabled", "true"));
    expect(row).toHaveTextContent("None yet");
    await user.click(row);
    expect(workspaceTrigger()).toHaveTextContent("Local");
  });

  it("offers only Local for a project that is not a git repo", async () => {
    const user = await openDialog();
    await pickProject(user, "alpha");

    const rail = screen.getByTestId("move-target-rail");
    expect(within(rail).getByTestId("workspace-target-trigger")).toHaveTextContent("Local");
    expect(within(rail).queryByRole("button")).toBeNull();
    expect(within(rail).queryByTestId("composer-branch-trigger")).toBeNull();
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "local" });
  });

  it("starts over for another project instead of carrying a worktree across", async () => {
    const user = await openDialog();
    await pickProject(user, "gitty");
    await chooseMode(user, "Existing worktree");
    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /^reconnect-retry/ }));
    expect(moveButton()).toBeEnabled();

    await pickProject(user, "gitty-two");

    expect(workspaceTrigger()).toHaveTextContent("Local");
    await user.click(moveButton());
    expect(await sentTarget()).toEqual({ kind: "local" });
  });
});

describe("MoveThreadDialog without a thread", () => {
  afterEach(() => {
    cleanup();
    closeMoveThreadDialog();
  });

  it("does not open for a thread the store does not hold", () => {
    useWorkspaceStore.setState({ workspaces: [ALPHA, HIDDEN], threads: [] });
    render(<MoveThreadDialogHost />);

    act(() => openMoveThreadDialog("missing"));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("thread.movedToProject push", () => {
  const marker = createMockMessage({ id: "move-marker", thread_id: THREAD.id, role: "system", content: "Moved to alpha" });
  const push = () => pushEmitter.emit("thread.movedToProject", { threadId: THREAD.id, thread: { ...THREAD, workspace_id: ALPHA.id }, marker });
  const markerCount = () => useThreadStore.getState().records.get(THREAD.id)?.messages.filter((message) => message.id === marker.id).length;

  beforeEach(() => {
    seed();
    resetThreadStoreForTests({ records: new Map([[THREAD.id, createEmptyThreadRecord()]]) });
    startPushListeners();
  });
  afterEach(() => {
    stopPushListeners();
    resetThreadStoreForTests();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("moves the row, follows it with the open thread, and appends the marker once", () => {
    act(() => push());
    act(() => push());

    expect(useWorkspaceStore.getState()).toMatchObject({ activeThreadId: THREAD.id, activeWorkspaceId: ALPHA.id });
    expect(useWorkspaceStore.getState().threads[0]?.workspace_id).toBe(ALPHA.id);
    expect(markerCount()).toBe(1);
  });

  it("leaves the open thread alone when another thread moves", () => {
    const other = createMockThread({ id: "t-2", workspace_id: HIDDEN.id });
    useWorkspaceStore.setState({ threads: [THREAD, other] });

    act(() => pushEmitter.emit("thread.movedToProject", { threadId: other.id, thread: { ...other, workspace_id: ALPHA.id }, marker }));

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(HIDDEN.id);
    expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === other.id)?.workspace_id).toBe(ALPHA.id);
  });
});
