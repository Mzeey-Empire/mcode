import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import type { ThreadMovePreflight } from "@mcode/contracts/ws/methods";
import type { WorkspaceMoveFrame, WorkspaceMoveResult } from "@mcode/contracts/ws/workspace-move";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

import { installListboxLayout } from "@/__tests__/helpers/picker-layout";
import { useThreadStore } from "@/stores/threadStore";
import { pushEmitter } from "@/transport/ws-transport";
import { useSidebarUiStore } from "../../sidebar/sidebar-ui-store";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { MoveThreadDialogHost } from "../MoveThreadDialog";
import { closeMoveThreadDialog, openMoveThreadDialog } from "../move-thread-store";

installListboxLayout();

const ALPHA = createMockWorkspace({ id: "ws-alpha", name: "alpha", path: "/work/alpha", is_git_repo: false });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });
const THREAD = createMockThread({ id: "t-1", title: "SQLite WAL vs rollback journal", workspace_id: HIDDEN.id });
const SHARER = createMockThread({ id: "t-2", title: "Branch: WAL checkpoint tuning", workspace_id: HIDDEN.id });
const OPERATION = "op-1";

function preflight(sharerTitles: readonly string[] = [SHARER.title]): ThreadMovePreflight {
  return {
    hasFiles: true,
    otherThreadsInFolder: { count: sharerTitles.length, titles: [...sharerTitles] },
    deadline: new Date(2026, 11, 3, 12).toISOString(),
    suggestedName: "sqlite-wal-vs-rollback",
    defaultLocation: "~/src",
  };
}

function frame(revision: number, result?: WorkspaceMoveResult): WorkspaceMoveFrame {
  return { operationId: OPERATION, revision, phase: result ? "done" : "renamed", copiedBytes: null, totalBytes: null, ...(result ? { result } : {}) };
}

function seed(workspaces = [ALPHA, HIDDEN]): void {
  useWorkspaceStore.setState({
    workspaces,
    workspacesLoaded: true,
    threads: [THREAD, SHARER],
    activeThreadId: THREAD.id,
    activeWorkspaceId: HIDDEN.id,
    pendingNewThread: false,
  });
}

async function openDialog(): Promise<UserEvent> {
  const user = userEvent.setup();
  render(<MoveThreadDialogHost />);
  act(() => openMoveThreadDialog(THREAD.id));
  await screen.findByRole("dialog", { name: /^Move to / });
  return user;
}

async function openNewProject(): Promise<UserEvent> {
  const user = await openDialog();
  await user.click(screen.getByTestId("new-thread-project-slot"));
  await user.click(await screen.findByRole("button", { name: /^New project from this folder/ }));
  await screen.findByRole("textbox", { name: "Name" });
  return user;
}

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const locationField = () => screen.getByRole("textbox", { name: "Location" });
const createButton = () => screen.getByRole("button", { name: /^(Create project|Try again|Moving…)$/ });

async function retype(user: UserEvent, field: HTMLElement, text: string): Promise<void> {
  await user.clear(field);
  if (text !== "") await user.type(field, text);
}

async function startMove(user: UserEvent): Promise<void> {
  vi.mocked(mockTransport.createProjectFromFolder).mockResolvedValueOnce({ operationId: OPERATION });
  await user.click(createButton());
  await waitFor(() => expect(mockTransport.readWorkspaceMoveStatus).toHaveBeenCalledWith({ operationId: OPERATION }));
}

function push(next: WorkspaceMoveFrame): void {
  act(() => pushEmitter.emit("workspace.move.progress", next));
}

describe("New project from this folder", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    seed();
    vi.mocked(mockTransport.readThreadMovePreflight).mockReset().mockResolvedValue(preflight());
    vi.mocked(mockTransport.createProjectFromFolder).mockReset();
    vi.mocked(mockTransport.readWorkspaceMoveStatus).mockReset().mockResolvedValue(null);
    vi.mocked(mockTransport.retryWorkspaceMoveGit).mockReset();
    vi.mocked(mockTransport.filesystemBrowse).mockReset();
    useThreadStore.setState({ runningThreadIds: new Set() });
    useSidebarUiStore.setState({ expandedProjects: new Set() });
  });

  afterEach(() => {
    cleanup();
    closeMoveThreadDialog();
    delete window.desktopBridge;
    useThreadStore.setState({ runningThreadIds: new Set() });
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  describe("form", () => {
    it("fills Name and Location from the server's suggestion and starts with git unchecked", async () => {
      await openNewProject();

      expect(screen.getByRole("heading", { name: "Move to a new project" })).toBeVisible();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      expect(locationField()).toHaveValue("~/src");
      expect(screen.getByRole("checkbox", { name: "Start a git repo" })).not.toBeChecked();
      expect(createButton()).toBeEnabled();
      expect(screen.queryByText(/Old files deleted/)).toBeNull();
    });

    it("sends the typed values and the git choice, shows Moving…, and closes once the project exists", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      await retype(user, nameField(), "wal-notes");
      await retype(user, locationField(), "  /work/notes  ");
      await user.click(screen.getByRole("checkbox", { name: "Start a git repo" }));

      await startMove(user);

      expect(mockTransport.createProjectFromFolder).toHaveBeenCalledExactlyOnceWith({ threadId: THREAD.id, name: "wal-notes", parentPath: "/work/notes", initGit: true });
      expect(createButton()).toHaveTextContent("Moving…");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
      expect(nameField()).toBeDisabled();
      expect(locationField()).toBeDisabled();

      push(frame(2, { status: "created", workspaceId: HIDDEN.id }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(useSidebarUiStore.getState().expandedProjects.has(HIDDEN.id)).toBe(true);
    });

    it.each([
      ["a name another project has", "alpha", "A project named alpha already exists. Choose another name."],
      ["a name another project has in other letters", "ALPHA", "A project named ALPHA already exists. Choose another name."],
      ["a character a folder name cannot hold", "wal notes", "Use letters, numbers, dots, dashes or underscores."],
      ["a Windows reserved name", "con", "con can't be used as a folder name. Choose another name."],
      ["a reserved name with an extension", "NUL.txt", "NUL.txt can't be used as a folder name. Choose another name."],
      ["a trailing dot", "notes.", "notes. can't be used as a folder name. Choose another name."],
    ])("refuses %s before any request, with the exact line", async (_case, name, message) => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      await retype(user, nameField(), name);

      expect(screen.getByText(message)).toBeVisible();
      expect(nameField()).toHaveAttribute("aria-invalid", "true");
      expect(createButton()).toBeDisabled();
      expect(mockTransport.createProjectFromFolder).not.toHaveBeenCalled();
    });

    it("shows no error for an empty name and keeps Create project disabled", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      await retype(user, nameField(), "");

      expect(nameField()).not.toHaveAttribute("aria-invalid");
      expect(createButton()).toBeDisabled();
    });

    it("asks for a full path under Location, and takes absolute, ~ and drive paths", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(locationField()).toHaveValue("~/src"));

      await retype(user, locationField(), "src/projects");
      expect(screen.getByText("Enter a full path, such as ~/src.")).toBeVisible();
      expect(createButton()).toBeDisabled();

      for (const accepted of ["~", "~/src", "/work/src", "D:\\work"]) {
        await retype(user, locationField(), accepted);
        expect(screen.queryByText("Enter a full path, such as ~/src.")).toBeNull();
        expect(createButton()).toBeEnabled();
      }
    });

    it.each([
      ["Project destination already exists", "name", "~/src/sqlite-wal-vs-rollback already exists. Choose another name or location."],
      ["A project with this name already exists", "name", "A project named sqlite-wal-vs-rollback already exists. Choose another name."],
      ["Invalid project name", "name", "Use letters, numbers, dots, dashes or underscores."],
      ["Project location must be an absolute folder", "location", "Enter a full path, such as ~/src."],
    ])("shows the server's refusal %j under the field it is about, and clears it on the next edit", async (error, field, message) => {
      vi.mocked(mockTransport.createProjectFromFolder).mockResolvedValueOnce({ status: "failed", error });
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      await user.click(createButton());

      expect(await screen.findByText(message)).toBeVisible();
      expect(field === "name" ? nameField() : locationField()).toHaveAttribute("aria-invalid", "true");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(createButton()).toHaveTextContent("Create project");

      await user.type(nameField(), "-2");
      expect(screen.queryByText(message)).toBeNull();
    });
  });

  describe("folder check", () => {
    it("keeps Create project disabled until the read answers", async () => {
      let answer: (read: ThreadMovePreflight) => void = () => {};
      vi.mocked(mockTransport.readThreadMovePreflight).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const user = await openNewProject();
      await user.type(nameField(), "wal-notes");
      await user.type(locationField(), "/work/notes");

      expect(createButton()).toBeDisabled();

      await act(async () => answer(preflight()));
      await waitFor(() => expect(createButton()).toBeEnabled());
    });

    it("keeps a Name typed before the read answers and still fills Location from the suggestion", async () => {
      let answer: (read: ThreadMovePreflight) => void = () => {};
      vi.mocked(mockTransport.readThreadMovePreflight).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const user = await openNewProject();
      await user.type(nameField(), "wal-notes");
      expect(locationField()).toHaveValue("");

      await act(async () => answer(preflight()));

      await waitFor(() => expect(locationField()).toHaveValue("~/src"));
      expect(nameField()).toHaveValue("wal-notes");
    });

    it("shows a notice and keeps Create project disabled when the read fails, and a successful Retry enables it", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight)
        .mockRejectedValueOnce(new Error("socket closed"))
        .mockResolvedValueOnce(preflight());
      const user = await openNewProject();
      await user.type(nameField(), "wal-notes");
      await user.type(locationField(), "/work/notes");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't check this thread's folder. Try again.");
      expect(createButton()).toBeDisabled();

      await user.click(within(alert).getByRole("button", { name: "Retry" }));

      expect(await screen.findByText("1 other thread works in this folder and moves with it")).toBeVisible();
      expect(screen.queryByText(/Couldn't check this thread's folder/)).toBeNull();
      expect(createButton()).toBeEnabled();
      expect(mockTransport.createProjectFromFolder).not.toHaveBeenCalled();
    });
  });

  describe("notices", () => {
    it("lists the other threads that move with the folder", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight).mockResolvedValue(preflight([SHARER.title, "Compare checkpoint modes"]));
      await openNewProject();

      const notice = await screen.findByRole("status");
      expect(notice).toHaveTextContent("2 other threads work in this folder and move with it");
      expect(within(notice).getAllByRole("listitem").map((item) => item.textContent)).toEqual([SHARER.title, "Compare checkpoint modes"]);
    });

    it("says 1 other thread, singular, for one sharer", async () => {
      await openNewProject();

      expect(await screen.findByText("1 other thread works in this folder and moves with it")).toBeVisible();
      expect(screen.getByText(SHARER.title)).toBeVisible();
    });

    it("shows no sharers notice when the thread is alone in the folder", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight).mockResolvedValue(preflight([]));
      await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows only the busy notice when the busy thread is the only other thread, and keeps Create project off", async () => {
      useThreadStore.setState({ runningThreadIds: new Set([SHARER.id]) });
      await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      const notice = await screen.findByRole("status");
      expect(notice).toHaveTextContent("“Branch: WAL checkpoint tuning” is running");
      expect(notice).toHaveTextContent("It works in this folder, so it moves with the new project. You can move once it stops.");
      expect(screen.queryByText(/other thread works in this folder/)).toBeNull();
      expect(createButton()).toBeDisabled();

      act(() => useThreadStore.setState({ runningThreadIds: new Set() }));
      expect(await screen.findByText("1 other thread works in this folder and moves with it")).toBeVisible();
      expect(createButton()).toBeEnabled();
    });

    it("shows both notices when a busy thread is not the only one", async () => {
      vi.mocked(mockTransport.readThreadMovePreflight).mockResolvedValue(preflight([SHARER.title, "Compare checkpoint modes"]));
      useThreadStore.setState({ runningThreadIds: new Set([SHARER.id]) });
      await openNewProject();

      expect(await screen.findByText("2 other threads work in this folder and move with it")).toBeVisible();
      expect(screen.getByText("“Branch: WAL checkpoint tuning” is running")).toBeVisible();
    });

    it("shows the server's busy refusal even when nothing in the stores says a thread is busy", async () => {
      vi.mocked(mockTransport.createProjectFromFolder).mockResolvedValueOnce({ status: "busy", threadId: SHARER.id, reason: "background" });
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      await user.click(createButton());

      expect(await screen.findByText("“Branch: WAL checkpoint tuning” has work running in the background")).toBeVisible();
      expect(screen.getByText(/You can move once that work stops\./)).toBeVisible();
    });
  });

  describe("destination", () => {
    it("offers the new project row under a divider with its hint, beside the projects", async () => {
      const user = await openDialog();

      await user.click(screen.getByTestId("new-thread-project-slot"));

      expect(await screen.findByRole("option", { name: "alpha" })).toBeVisible();
      const row = screen.getByRole("button", { name: /^New project from this folder/ });
      expect(row).not.toHaveAttribute("aria-current");
      expect(within(row).getByText("Keeps the files")).toBeVisible();
    });

    it("drops the hint and shows a check once the row is the choice", async () => {
      const user = await openNewProject();

      await user.click(screen.getByTestId("new-thread-project-slot"));

      const row = await screen.findByRole("button", { name: "New project from this folder" });
      expect(row).toHaveAttribute("aria-current", "true");
      expect(screen.queryByText("Keeps the files")).toBeNull();
    });

    it("opens on a new project when there are no projects, and the chooser holds only that row", async () => {
      seed([HIDDEN]);
      const user = await openDialog();

      expect(screen.getByRole("heading", { name: "Move to a new project" })).toBeVisible();
      await user.click(screen.getByTestId("new-thread-project-slot"));

      const chooser = await screen.findByRole("dialog", { name: "Choose project" });
      expect(within(chooser).getAllByRole("button")).toHaveLength(1);
      expect(within(chooser).getByRole("button", { name: "New project from this folder" })).toHaveAttribute("aria-current", "true");
      expect(within(chooser).queryByPlaceholderText("Search projects")).toBeNull();
      expect(within(chooser).queryByText("Keeps the files")).toBeNull();
    });

    it("leaves the form for a project the user picks instead, and the footer says Move thread", async () => {
      const user = await openNewProject();

      await user.click(screen.getByTestId("new-thread-project-slot"));
      await user.click(await screen.findByRole("option", { name: "alpha" }));

      expect(screen.getByRole("heading", { name: "Move to alpha" })).toBeVisible();
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
      expect(screen.getByRole("button", { name: "Move thread" })).toBeVisible();
    });
  });

  describe("opening", () => {
    it("focuses Name when there are no projects, because the form is the only task", async () => {
      seed([HIDDEN]);
      await openDialog();

      await waitFor(() => expect(nameField()).toHaveFocus());
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("keeps focus off the project slot, so no ring is drawn and no tooltip opens over the thread title", async () => {
      await openDialog();

      await waitFor(() => expect(screen.getByRole("dialog", { name: /^Move to / })).toHaveFocus());
      expect(screen.getByTestId("new-thread-project-slot")).not.toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });

  describe("a move that does not finish cleanly", () => {
    it("names the project it could not move the folder to, not the Location, says nothing changed, and Try again sends the request again", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      await retype(user, nameField(), "wal-notes");
      await startMove(user);

      push(frame(2, { status: "failed", error: "EBUSY: resource busy or locked, rename 'a'" }));

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText("Couldn't move the folder to wal-notes")).toBeVisible();
      expect(alert).not.toHaveTextContent("~/src");
      expect(alert).toHaveTextContent("Nothing changed: the threads are still in No project. Close any app using files in the folder, then try again.");
      expect(screen.queryByText("EBUSY: resource busy or locked, rename 'a'")).toBeNull();
      await user.click(within(alert).getByRole("button", { name: "Show details" }));
      expect(screen.getByText("EBUSY: resource busy or locked, rename 'a'")).toBeVisible();

      expect(createButton()).toHaveTextContent("Try again");
      await startMove(user);
      expect(mockTransport.createProjectFromFolder).toHaveBeenCalledTimes(2);
    });

    it("does not promise that nothing changed when the request never answered", async () => {
      vi.mocked(mockTransport.createProjectFromFolder).mockRejectedValueOnce(new Error("socket closed"));
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      await user.click(createButton());

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Mcode could not confirm the move.");
      expect(alert).not.toHaveTextContent("Nothing changed");
    });

    it("says where the files are when the rollback itself failed, and offers no Try again", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      await startMove(user);

      push(frame(3, { status: "rollback-pending", error: "EPERM: operation not permitted", markerPath: "/home/.mcode/no-project/a/.mcode-move.json" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Mcode couldn't put the folder back. Your files are in /home/.mcode/no-project/a.");
      expect(alert).toHaveTextContent("The threads in this folder can't run until Mcode finishes; it will try again when it restarts.");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
      await user.click(within(alert).getByRole("button", { name: "Show details" }));
      expect(screen.getByText("EPERM: operation not permitted")).toBeVisible();
    });
  });

  describe("git setup failed", () => {
    const gitFailed = (error = "git: 'init' failed: Permission denied"): WorkspaceMoveResult => ({ status: "git-failed", workspaceId: HIDDEN.id, error });

    async function reachGitFailure(): Promise<UserEvent> {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      await user.click(screen.getByRole("checkbox", { name: "Start a git repo" }));
      await startMove(user);
      return user;
    }

    it("alerts that the project exists, even when the converted workspace reaches the store first", async () => {
      await reachGitFailure();
      act(() => useWorkspaceStore.setState({ workspaces: [ALPHA, { ...HIDDEN, kind: "project", name: "sqlite-wal-vs-rollback" }] }));

      push(frame(3, gitFailed()));

      const alert = await screen.findByRole("alertdialog", { name: "Project created" });
      expect(alert).toHaveTextContent("“SQLite WAL vs rollback journal” now runs in the sqlite-wal-vs-rollback project.");
      expect(within(alert).getByRole("alert")).toHaveTextContent("Couldn't start a git repo");
      expect(within(alert).getByRole("alert")).toHaveTextContent("Permission was denied in the project folder. The project works without git. Check you can write to ~/src/sqlite-wal-vs-rollback, then retry, or run git init later.");
      expect(useSidebarUiStore.getState().expandedProjects.has(HIDDEN.id)).toBe(true);
    });

    it("Retry git setup retries the operation, then shows git as started and waits for Done", async () => {
      vi.mocked(mockTransport.retryWorkspaceMoveGit).mockResolvedValueOnce({ status: "created", workspaceId: HIDDEN.id });
      const user = await reachGitFailure();
      act(() => useWorkspaceStore.setState({ workspaces: [ALPHA, { ...HIDDEN, kind: "project", name: "sqlite-wal-vs-rollback" }] }));
      push(frame(3, gitFailed()));
      const alert = await screen.findByRole("alertdialog", { name: "Project created" });

      await user.click(within(alert).getByRole("button", { name: "Retry git setup" }));

      expect(mockTransport.retryWorkspaceMoveGit).toHaveBeenCalledExactlyOnceWith(OPERATION);
      expect(await within(alert).findByText("Git repo started")).toBeVisible();
      expect(within(alert).queryByText("Couldn't start a git repo")).toBeNull();
      expect(within(alert).queryByRole("button", { name: "Retry git setup" })).toBeNull();
      expect(screen.getByRole("alertdialog", { name: "Project created" })).toBeVisible();
      expect(within(alert).getByRole("button", { name: "Done" })).toHaveFocus();

      await user.click(within(alert).getByRole("button", { name: "Done" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("keeps the alert, with the new reason, when the retry fails too", async () => {
      vi.mocked(mockTransport.retryWorkspaceMoveGit).mockResolvedValueOnce({ status: "git-failed", workspaceId: HIDDEN.id, error: "git: not found" });
      const user = await reachGitFailure();
      push(frame(3, gitFailed()));
      const alert = await screen.findByRole("alertdialog", { name: "Project created" });

      await user.click(within(alert).getByRole("button", { name: "Retry git setup" }));

      await waitFor(() => expect(within(alert).getByRole("button", { name: "Retry git setup" })).toBeEnabled());
      await user.click(within(alert).getByRole("button", { name: "Show details" }));
      expect(within(alert).getByText("git: not found")).toBeVisible();
      expect(alert).toBeVisible();
    });

    it("closes on Done", async () => {
      const user = await reachGitFailure();
      push(frame(3, gitFailed()));

      await user.click(await screen.findByRole("button", { name: "Done" }));

      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  describe("following the move", () => {
    it("shows the terminal result of a move that completed between the thread lookup and the subscription", async () => {
      vi.mocked(mockTransport.readWorkspaceMoveStatus).mockImplementation(async (input) => {
        if ("threadId" in input) return frame(1);
        return frame(4, { status: "git-failed", workspaceId: HIDDEN.id, error: "git: 'init' failed" });
      });

      await openDialog();

      expect(await screen.findByRole("alertdialog", { name: "Project created" })).toBeVisible();
      expect(mockTransport.readWorkspaceMoveStatus).toHaveBeenNthCalledWith(1, { threadId: THREAD.id });
      expect(mockTransport.readWorkspaceMoveStatus).toHaveBeenNthCalledWith(2, { operationId: OPERATION });
    });

    it("opens on Moving… for a thread whose move is still running", async () => {
      vi.mocked(mockTransport.readWorkspaceMoveStatus).mockResolvedValue(frame(1));

      await openDialog();

      expect(await screen.findByRole("button", { name: "Moving…" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Move to a new project" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });

    it("keeps Create project off until the look for a running move ends, then follows that move to its result", async () => {
      // The look is held rather than slept on, so the test decides when it ends.
      let endLookup: (found: WorkspaceMoveFrame) => void = () => {};
      vi.mocked(mockTransport.readWorkspaceMoveStatus).mockImplementation((input) =>
        "threadId" in input ? new Promise((resolve) => { endLookup = resolve; }) : Promise.resolve(frame(1)));
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));

      expect(createButton()).toBeDisabled();
      await user.click(createButton());
      expect(mockTransport.createProjectFromFolder).not.toHaveBeenCalled();

      await act(async () => endLookup(frame(1)));
      expect(createButton()).toHaveTextContent("Moving…");
      push(frame(2, { status: "failed", error: "EBUSY: resource busy or locked, rename 'a'" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't move the folder to sqlite-wal-vs-rollback");
      expect(mockTransport.createProjectFromFolder).not.toHaveBeenCalled();
    });

    it("keeps the newer result when an older status read lands after a pushed frame", async () => {
      let answerStatus: (read: WorkspaceMoveFrame) => void = () => {};
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      vi.mocked(mockTransport.readWorkspaceMoveStatus).mockImplementation((input) =>
        "operationId" in input ? new Promise((resolve) => { answerStatus = resolve; }) : Promise.resolve(null));
      vi.mocked(mockTransport.createProjectFromFolder).mockResolvedValueOnce({ operationId: OPERATION });
      await user.click(createButton());
      await waitFor(() => expect(mockTransport.readWorkspaceMoveStatus).toHaveBeenCalledWith({ operationId: OPERATION }));

      push(frame(3, { status: "failed", error: "EBUSY: locked" }));
      await act(async () => answerStatus(frame(1)));

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't move the folder to sqlite-wal-vs-rollback");
      expect(screen.queryByRole("button", { name: "Moving…" })).toBeNull();
    });

    describe("when the status read fails", () => {
      async function startWithFailingStatusRead(readOutcomes: readonly (WorkspaceMoveFrame | Error)[]): Promise<void> {
        await openNewProject();
        await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
        const outcomes = [...readOutcomes];
        vi.mocked(mockTransport.readWorkspaceMoveStatus).mockImplementation(async (input) => {
          if ("threadId" in input) return null;
          const next = outcomes.shift() ?? new Error("socket closed");
          if (next instanceof Error) throw next;
          return next;
        });
        vi.mocked(mockTransport.createProjectFromFolder).mockResolvedValueOnce({ operationId: OPERATION });
        // The backoff is real timer work, so only timeouts are faked and the click goes straight to the DOM.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await act(async () => { createButton().click(); });
      }

      const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("ends Moving… with the sidebar notice and an enabled Close once every read has failed", async () => {
        await startWithFailingStatusRead([]);
        expect(createButton()).toHaveTextContent("Moving…");

        await settle();

        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't get the result of the move. Check the sidebar to see where the thread is.");
        expect(screen.queryByRole("button", { name: "Moving…" })).toBeNull();
        expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Close dialog" })).toBeEnabled();
        expect(vi.mocked(mockTransport.readWorkspaceMoveStatus).mock.calls.filter(([input]) => "operationId" in input)).toHaveLength(3);
        expect(mockTransport.createProjectFromFolder).toHaveBeenCalledTimes(1);
      });

      it("shows the real result when a later read succeeds", async () => {
        await startWithFailingStatusRead([new Error("socket closed"), frame(4, { status: "git-failed", workspaceId: HIDDEN.id, error: "git: 'init' failed" })]);

        await settle();

        expect(screen.getByRole("alertdialog", { name: "Project created" })).toBeVisible();
        expect(screen.queryByText(/Couldn't get the result of the move/)).toBeNull();
      });

      it("keeps following the move when a frame arrived, because the pushes work", async () => {
        await startWithFailingStatusRead([]);
        push(frame(2));

        await settle();

        expect(createButton()).toHaveTextContent("Moving…");
        expect(screen.queryByText(/Couldn't get the result of the move/)).toBeNull();
      });
    });

    it("ignores frames of another operation", async () => {
      const user = await openNewProject();
      await waitFor(() => expect(nameField()).toHaveValue("sqlite-wal-vs-rollback"));
      await startMove(user);

      act(() => pushEmitter.emit("workspace.move.progress", { ...frame(9, { status: "created", workspaceId: "ws-other" }), operationId: "op-other" }));

      expect(createButton()).toHaveTextContent("Moving…");
      expect(screen.getByRole("dialog", { name: /^Move to / })).toBeVisible();
    });
  });

  describe("Browse", () => {
    it("opens the server's folder browser in the web app, descends into a folder, and puts the choice in Location", async () => {
      vi.mocked(mockTransport.filesystemBrowse).mockImplementation(async (path) =>
        path === "/work/clients"
          ? { path: "/work/clients", parent: "/work", entries: [{ name: "acme", isDir: true }, { name: "notes.txt", isDir: false }], requestedPath: "folder", isTooBroad: false }
          : { path: "/work", parent: "/", entries: [{ name: "clients", isDir: true }], requestedPath: "folder", isTooBroad: false });
      const user = await openNewProject();
      await waitFor(() => expect(locationField()).toHaveValue("~/src"));
      await retype(user, locationField(), "/work");

      await user.click(screen.getByRole("button", { name: "Browse…" }));
      const browser = await screen.findByRole("dialog", { name: "Choose a folder" });
      await user.click(await within(browser).findByRole("option", { name: "clients" }));
      expect(await within(browser).findByRole("option", { name: "acme" })).toBeVisible();
      expect(within(browser).queryByRole("option", { name: "notes.txt" })).toBeNull();
      await user.click(within(browser).getByRole("button", { name: "Use this folder" }));

      expect(locationField()).toHaveValue("/work/clients");
      expect(screen.queryByRole("dialog", { name: "Choose a folder" })).toBeNull();
    });

    it("opens the native folder dialog in Electron and puts the choice in Location", async () => {
      const showOpenDialog = vi.fn().mockResolvedValue("D:\\work\\clients");
      window.desktopBridge = { showOpenDialog } as unknown as typeof window.desktopBridge;
      const user = await openNewProject();
      await waitFor(() => expect(locationField()).toHaveValue("~/src"));

      await user.click(screen.getByRole("button", { name: "Browse…" }));

      await waitFor(() => expect(locationField()).toHaveValue("D:\\work\\clients"));
      expect(screen.queryByRole("dialog", { name: "Choose a folder" })).toBeNull();
      expect(mockTransport.filesystemBrowse).not.toHaveBeenCalled();
    });

    it("leaves Location alone when the native dialog is cancelled", async () => {
      window.desktopBridge = { showOpenDialog: vi.fn().mockResolvedValue(null) } as unknown as typeof window.desktopBridge;
      const user = await openNewProject();
      await waitFor(() => expect(locationField()).toHaveValue("~/src"));

      await user.click(screen.getByRole("button", { name: "Browse…" }));

      expect(locationField()).toHaveValue("~/src");
    });
  });
});
