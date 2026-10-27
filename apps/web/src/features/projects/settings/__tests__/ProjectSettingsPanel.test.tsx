import { mockTransport } from "@/__tests__/mocks/transport";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentReadResult } from "@mcode/contracts/models/workspace-environment";

const { MockRpcError, applyActionRun } = vi.hoisted(() => {
  class MockRpcError extends Error {
    readonly data?: Record<string, unknown>;

    constructor(message: string, readonly code: string, data?: Record<string, unknown>) {
      super(message);
      this.name = "RpcError";
      this.data = data;
    }
  }
  return {
    MockRpcError,
    applyActionRun: vi.fn(),
  };
});

const transport = {
  readWorkspaceEnvironment: vi.mocked(mockTransport.readWorkspaceEnvironment),
  saveWorkspaceEnvironment: vi.mocked(mockTransport.saveWorkspaceEnvironment),
  setWorkspaceEnvironmentStorageMode: vi.mocked(mockTransport.setWorkspaceEnvironmentStorageMode),
  forgetWorkspaceEnvironmentApproval: vi.mocked(mockTransport.forgetWorkspaceEnvironmentApproval),
  startWorkspaceAction: vi.mocked(mockTransport.startWorkspaceAction),
};

vi.mock("@/transport", () => ({ getTransport: () => mockTransport, RpcError: MockRpcError }));

beforeEach(() => {
  vi.mocked(mockTransport.readWorkspaceEnvironment).mockReset();
  vi.mocked(mockTransport.saveWorkspaceEnvironment).mockReset();
  vi.mocked(mockTransport.setWorkspaceEnvironmentStorageMode).mockReset();
  vi.mocked(mockTransport.forgetWorkspaceEnvironmentApproval).mockReset();
  vi.mocked(mockTransport.startWorkspaceAction).mockReset();
});
vi.mock("@/features/terminal/state/applyActionRun", () => ({ applyActionRun: applyActionRun }));
vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { workspaces: readonly { id: string; name: string; path: string; icon_path: null }[] }) => unknown) =>
    selector({ workspaces: [{ id: "workspace-1", name: "Caravan", path: "/src/caravan", icon_path: null }] }),
}));

import { ProjectSettingsPanel } from "../ProjectSettingsPanel";
import { useProjectSettingsDraftStore } from "../projectSettingsDraftStore";

const build: WorkspaceEnvironmentAction = { id: "build", name: "Build", command: { default: "bun run build" } };

function result(
  actions: readonly WorkspaceEnvironmentAction[],
  extra: Partial<WorkspaceEnvironmentReadResult> = {},
): WorkspaceEnvironmentReadResult {
  return { document: { version: "0.0.1", actions: [...actions] }, revision: "rev-1", status: "present", ...extra };
}

async function openAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: new RegExp(name), expanded: false }));
}

describe("ProjectSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectSettingsDraftStore.setState({ drafts: {} });
    transport.readWorkspaceEnvironment.mockResolvedValue(result([build]));
    transport.saveWorkspaceEnvironment.mockImplementation(async (_id: string, document: WorkspaceEnvironmentReadResult["document"]) => ({
      document,
      revision: "rev-2",
      status: "present",
    }));
  });

  it("opens on Actions and switches to General, which has no Action button", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await screen.findByRole("button", { name: /^Build/ });
    expect(screen.getByRole("radio", { name: "Actions" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "General" }));

    expect(screen.getByRole("radio", { name: "General" })).toBeChecked();
    expect(screen.getByLabelText("Name")).toHaveValue("Caravan");
    expect(screen.queryByRole("button", { name: "Action" })).toBeNull();
  });

  it("adds an action, takes its command and saves it", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await screen.findByRole("button", { name: /^Build/ });

    await user.click(screen.getByRole("button", { name: "Action" }));
    expect(await screen.findByLabelText("Action name")).toHaveValue("action");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Add a command to save this action.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Command"), "echo hi");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
    const [, saved, revision] = transport.saveWorkspaceEnvironment.mock.calls[0] as [string, WorkspaceEnvironmentReadResult["document"], string];
    expect(revision).toBe("rev-1");
    expect(saved.actions.map((action) => [action.name, action.command.default])).toEqual([
      ["Build", "bun run build"],
      ["action", "echo hi"],
    ]);
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
  });

  it("keeps Save off with the limit message once a ninth action runs on startup", async () => {
    const user = userEvent.setup();
    const startup = Array.from({ length: 9 }, (_, index): WorkspaceEnvironmentAction => ({
      id: `a${index}`,
      name: `Task ${index}`,
      command: { default: "true" },
      ...(index < 8 ? { runOnStartup: true } : {}),
    }));
    transport.readWorkspaceEnvironment.mockResolvedValue(result(startup));
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);

    await openAction(user, "Task 8");
    await user.click(screen.getByRole("switch", { name: /^Run on startup/ }));

    expect(await screen.findByText("At most 8 actions can run on startup.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the server's reason for a rejected save next to the action", async () => {
    const user = userEvent.setup();
    transport.saveWorkspaceEnvironment.mockRejectedValue(
      new MockRpcError("invalid", "WORKSPACE_ENVIRONMENT_VALIDATION", {
        issues: [{ path: ["actions", 0, "command", "default"], code: "SCRIPT_TOO_LARGE", reason: "script_too_large", message: "x" }],
      }),
    );
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await openAction(user, "Build");
    await user.type(screen.getByLabelText("Command"), " --watch");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("This command is too long. The limit is 32 KB.")).toBeInTheDocument();
  });

  it("does not pin a server issue on a command that was corrected while the save ran", async () => {
    const user = userEvent.setup();
    let reject: (error: unknown) => void = () => undefined;
    transport.saveWorkspaceEnvironment.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await openAction(user, "Build");
    await user.type(screen.getByLabelText("Command"), " --watch");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.type(screen.getByLabelText("Command"), "!");
    reject(new MockRpcError("invalid", "WORKSPACE_ENVIRONMENT_VALIDATION", {
      issues: [{ path: ["actions", 0, "command", "default"], code: "SCRIPT_TOO_LARGE", reason: "script_too_large", message: "x" }],
    }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.queryByText("This command is too long. The limit is 32 KB.")).not.toBeInTheDocument();
  });

  it("keeps the draft and save bar when the panel moves to another thread and back", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectSettingsPanel key="thread-1" workspaceId="workspace-1" threadId="thread-1" />);
    await openAction(user, "Build");
    await user.clear(screen.getByLabelText("Action name"));
    await user.type(screen.getByLabelText("Action name"), "Compile");

    rerender(<ProjectSettingsPanel key="thread-2" workspaceId="workspace-1" threadId="thread-2" />);
    rerender(<ProjectSettingsPanel key="thread-1b" workspaceId="workspace-1" threadId="thread-1" />);

    expect(await screen.findByLabelText("Action name")).toHaveValue("Compile");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  describe("when the file changed on disk", () => {
    async function editThenSaveStale(user: ReturnType<typeof userEvent.setup>) {
      transport.readWorkspaceEnvironment.mockResolvedValue(result([build], { storageMode: "shared" }));
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");
      await user.clear(screen.getByLabelText("Action name"));
      await user.type(screen.getByLabelText("Action name"), "Mine");
      transport.readWorkspaceEnvironment.mockResolvedValue(
        result([{ ...build, name: "Theirs" }], { revision: "rev-9", storageMode: "shared" }),
      );
      transport.saveWorkspaceEnvironment.mockRejectedValueOnce(new MockRpcError("stale", "WORKSPACE_ENVIRONMENT_STALE"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("alert");
    }

    it("saves the draft over the new revision on Keep mine", async () => {
      const user = userEvent.setup();
      await editThenSaveStale(user);

      await user.click(screen.getByRole("button", { name: "Keep mine" }));

      await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledTimes(2));
      const [, saved, revision] = transport.saveWorkspaceEnvironment.mock.calls[1] as [string, WorkspaceEnvironmentReadResult["document"], string];
      expect(revision).toBe("rev-9");
      expect(saved.actions[0]?.name).toBe("Mine");
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("drops the banner when the draft is edited back to what was loaded", async () => {
      const user = userEvent.setup();
      await editThenSaveStale(user);

      await user.clear(screen.getByLabelText("Action name"));
      await user.type(screen.getByLabelText("Action name"), "Build");

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });

    it("shows the disk version once the draft is edited back, so the conflict does not linger", async () => {
      const user = userEvent.setup();
      await editThenSaveStale(user);

      await user.clear(screen.getByLabelText("Action name"));
      await user.type(screen.getByLabelText("Action name"), "Build");

      await waitFor(() => expect(screen.getByLabelText("Action name")).toHaveValue("Theirs"));
      expect(useProjectSettingsDraftStore.getState().drafts["workspace-1"]?.conflict).toBe(false);
    });

    it("keeps edits typed while Reload is reading the file", async () => {
      const user = userEvent.setup();
      await editThenSaveStale(user);
      let finish: (value: WorkspaceEnvironmentReadResult) => void = () => undefined;
      transport.readWorkspaceEnvironment.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

      await user.click(screen.getByRole("button", { name: "Reload" }));
      await user.type(screen.getByLabelText("Action name"), "!");
      finish(result([{ ...build, name: "Theirs" }], { revision: "rev-9", storageMode: "shared" }));

      await waitFor(() => expect(screen.getByLabelText("Action name")).toHaveValue("Mine!"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows the disk version on Reload", async () => {
      const user = userEvent.setup();
      await editThenSaveStale(user);
      expect(screen.getByText(".mcode/environment.json changed on disk")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Reload" }));

      await waitFor(() => expect(screen.getByLabelText("Action name")).toHaveValue("Theirs"));
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
      expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce();
    });
  });

  describe("storage", () => {
    it("blocks switching where actions are saved while there are unsaved changes", async () => {
      const user = userEvent.setup();
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");
      await user.type(screen.getByLabelText("Action name"), "!");

      expect(screen.getByRole("radio", { name: "In repo" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "This computer" })).toBeDisabled();
    });

    it("switches to the repo file while clean", async () => {
      const user = userEvent.setup();
      transport.setWorkspaceEnvironmentStorageMode.mockResolvedValue(result([build], { storageMode: "shared", approvedActionIds: [] }));
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await screen.findByRole("button", { name: /^Build/ });

      await user.click(screen.getByRole("radio", { name: "In repo" }));

      await waitFor(() => expect(transport.setWorkspaceEnvironmentStorageMode).toHaveBeenCalledWith("workspace-1", "shared"));
      await waitFor(() => expect(screen.getByRole("radio", { name: "In repo" })).toBeChecked());
    });

    it("forgets the approval of one In repo action", async () => {
      const user = userEvent.setup();
      transport.readWorkspaceEnvironment.mockResolvedValue(
        result([build], { storageMode: "shared", approvedActionIds: ["build"] }),
      );
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");

      await user.click(screen.getByRole("button", { name: "More" }));
      await user.click(await screen.findByRole("menuitem", { name: "Forget approval" }));

      await waitFor(() => expect(transport.forgetWorkspaceEnvironmentApproval).toHaveBeenCalledWith("workspace-1", "build"));
      await user.click(screen.getByRole("button", { name: "More" }));
      expect(screen.queryByRole("menuitem", { name: "Forget approval" })).not.toBeInTheDocument();
    });
  });

  it("duplicates an action under a new id and saves both", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await openAction(user, "Build");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate action" }));
    expect(await screen.findByLabelText("Action name")).toHaveValue("Build copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
    const [, saved] = transport.saveWorkspaceEnvironment.mock.calls[0];
    expect(saved.actions.map((action) => [action.name, action.command.default])).toEqual([
      ["Build", "bun run build"],
      ["Build copy", "bun run build"],
    ]);
    expect(new Set(saved.actions.map((action) => action.id)).size).toBe(2);
  });

  it("returns focus to the collapsed row when Escape closes the editor", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    await openAction(user, "Build");

    await user.click(screen.getByLabelText("Action name"));
    await user.keyboard("{Escape}");

    const row = await screen.findByRole("button", { name: /^Build/, expanded: false });
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("moves keyboard focus into the editor when a row opens with Enter", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    const row = await screen.findByRole("button", { name: /^Build/, expanded: false });

    row.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByLabelText("Action name")).toHaveFocus());
  });

  it("does not install a save result over the actions of a thread that was read meanwhile", async () => {
    const user = userEvent.setup();
    let finish: (value: WorkspaceEnvironmentReadResult) => void = () => undefined;
    transport.saveWorkspaceEnvironment.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<ProjectSettingsPanel key="thread-1" workspaceId="workspace-1" threadId="thread-1" />);
    await openAction(user, "Build");
    await user.type(screen.getByLabelText("Action name"), " A");
    await user.click(screen.getByRole("button", { name: "Save" }));

    transport.readWorkspaceEnvironment.mockResolvedValue(result([{ ...build, name: "Other checkout" }], { revision: "rev-9" }));
    rerender(<ProjectSettingsPanel key="thread-2" workspaceId="workspace-1" threadId="thread-2" />);
    await screen.findByRole("alert");
    finish(result([{ ...build, name: "Build A" }], { revision: "rev-2" }));

    await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = useProjectSettingsDraftStore.getState().drafts["workspace-1"];
    expect(entry?.base.revision).toBe("rev-1");
    expect(entry?.conflict).toBe(true);
  });

  it("explains why an action cannot run without a thread", async () => {
    render(<ProjectSettingsPanel workspaceId="workspace-1" />);
    const row = (await screen.findByRole("button", { name: /^Build/ })).closest("div");
    expect(within(row as HTMLElement).getByRole("button", { name: "Run Build" })).toBeDisabled();
  });

  it("runs a saved action in the open thread and shows its terminal", async () => {
    const user = userEvent.setup();
    const run: Awaited<ReturnType<typeof mockTransport.startWorkspaceAction>> = {
      actionId: "build",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      revision: 1,
      terminalSessionId: "terminal-1",
      trigger: "manual",
      port: null,
      actionName: "Build",
      status: "running",
      snapshot: {
        platform: "windows",
        script: "bun run build",
        checkoutPath: "C:/repo",
        terminal: null,
        environmentNames: [],
      },
      createdAt: "2026-10-27T10:00:00.000Z",
      startedAt: "2026-10-27T10:00:00.000Z",
      finishedAt: null,
      exitCode: null,
    };
    transport.startWorkspaceAction.mockResolvedValue(run);
    render(<ProjectSettingsPanel workspaceId="workspace-1" threadId="thread-1" />);

    await user.click(await screen.findByRole("button", { name: "Run Build" }));

    await waitFor(() => expect(transport.startWorkspaceAction).toHaveBeenCalledWith("thread-1", "build"));
    await waitFor(() => expect(applyActionRun).toHaveBeenCalledWith(run, { focus: true }));
  });

  it("will not run until the actions were read for the thread it would run in", async () => {
    const { rerender } = render(<ProjectSettingsPanel workspaceId="workspace-1" threadId="thread-1" />);
    expect(await screen.findByRole("button", { name: "Run Build" })).toBeEnabled();

    transport.readWorkspaceEnvironment.mockReturnValue(new Promise(() => undefined));
    rerender(<ProjectSettingsPanel workspaceId="workspace-1" threadId="thread-2" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Run Build" })).toBeDisabled());
  });

  describe("action options", () => {
    const savedActions = () =>
      transport.saveWorkspaceEnvironment.mock.calls[0][1].actions;

    it("disables the wait row with its reason until Run on startup is on", async () => {
      const user = userEvent.setup();
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");
      const wait = screen.getByRole("switch", { name: /^Wait for it to finish/ });
      expect(wait).toHaveAttribute("aria-disabled", "true");

      await user.hover(wait.closest("label") ?? wait);
      expect(await screen.findByText("Requires Run on startup")).toBeInTheDocument();

      await user.click(screen.getByRole("switch", { name: /^Run on startup/ }));
      expect(screen.getByRole("switch", { name: /^Wait for it to finish/ })).not.toHaveAttribute("aria-disabled", "true");
    });

    it("drops a released gate when Run on startup turns off, so no inert key is saved", async () => {
      const user = userEvent.setup();
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");
      await user.click(screen.getByRole("switch", { name: /^Run on startup/ }));
      await user.click(screen.getByRole("switch", { name: /^Wait for it to finish/ }));
      await user.click(screen.getByRole("switch", { name: /^Run on startup/ }));
      await user.click(screen.getByRole("switch", { name: /^Run when the thread settles/ }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
      expect(savedActions()[0]).toEqual({ ...build, runOnSettle: true });
    });

    it("puts a non-localhost preview URL error on the URL field and keeps Save off", async () => {
      const user = userEvent.setup();
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      await openAction(user, "Build");
      expect(screen.queryByLabelText("Preview URL")).toBeNull();
      await user.click(screen.getByRole("switch", { name: /^Open preview automatically/ }));
      await user.type(screen.getByLabelText("Preview URL"), "https://example.com");

      expect(await screen.findByText("Use a localhost URL")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview URL")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Command")).not.toHaveAttribute("aria-invalid");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

      await user.clear(screen.getByLabelText("Preview URL"));
      await user.type(screen.getByLabelText("Preview URL"), "http://localhost:5173");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(transport.saveWorkspaceEnvironment).toHaveBeenCalledOnce());
      expect(savedActions()[0]).toEqual({ ...build, openPreview: "http://localhost:5173" });
    });

    it("shows a chip for each trigger that is on in the collapsed row", async () => {
      transport.readWorkspaceEnvironment.mockResolvedValue(
        result([{ ...build, runOnSettle: true, runOnCleanup: true, waitForExit: false }]),
      );
      render(<ProjectSettingsPanel workspaceId="workspace-1" />);
      const row = await screen.findByRole("button", { name: /^Build/ });
      expect(within(row).getByText("On settle")).toBeInTheDocument();
      expect(within(row).getByText("On cleanup")).toBeInTheDocument();
      expect(within(row).queryByText("On startup")).toBeNull();
    });
  });
});
