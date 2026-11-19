import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallUpdateResult, UpdateStatus } from "@/transport/desktop-bridge";
import { useUpdateStore } from "@/stores/updateStore";
import { ReleaseNotesCard } from "../ReleaseNotesCard";
import { UP_TO_DATE_FLASH_MS, UpdateButton } from "../UpdateButton";

const STARTED: InstallUpdateResult = { kind: "started" };
const busy = (runningAgents: number | null): InstallUpdateResult => ({ kind: "agents-running", runningAgents });

function createApp() {
  return {
    checkForUpdates: vi.fn<() => Promise<UpdateStatus>>().mockResolvedValue({ state: "idle" }),
    downloadUpdate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    installUpdate: vi.fn<(request?: { confirmed?: boolean }) => Promise<InstallUpdateResult>>().mockResolvedValue(STARTED),
    getUpdateStatus: vi.fn<() => Promise<UpdateStatus>>().mockResolvedValue({ state: "idle" }),
    installWhenIdle: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    cancelInstallWhenIdle: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

let app: ReturnType<typeof createApp>;
const openExternalUrl = vi.fn();

function showStatus(...statuses: UpdateStatus[]) {
  act(() => {
    for (const status of statuses) useUpdateStore.getState().setStatus(status);
  });
}

beforeEach(() => {
  app = createApp();
  openExternalUrl.mockReset();
  vi.stubGlobal("desktopBridge", { app, openExternalUrl });
  useUpdateStore.setState({ status: { state: "idle" }, pendingVersion: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("UpdateButton states", () => {
  it("rests as a check button and checks on click", async () => {
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(app.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("shows a spinner while checking", () => {
    showStatus({ state: "checking" });
    render(<UpdateButton />);
    expect(screen.getByRole("status", { name: "Checking for updates" })).toBeInTheDocument();
  });

  it("offers Download with the version and downloads on click", async () => {
    showStatus({ state: "available", version: "0.10.0" });
    render(<UpdateButton />);
    const button = screen.getByRole("button", { name: /Download/ });
    expect(button).toHaveTextContent("Downloadv0.10.0");
    await userEvent.click(button);
    expect(app.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("shows the remembered version and percent while downloading", () => {
    showStatus({ state: "available", version: "0.10.0" }, { state: "downloading", percent: 42.4 });
    render(<UpdateButton />);
    expect(screen.getByRole("status", { name: "Downloading update, 42%" })).toHaveTextContent("v0.10.0 · 42%");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Install with the version once downloaded", () => {
    showStatus({ state: "downloaded", version: "0.10.0", installWhenIdle: false });
    render(<UpdateButton />);
    expect(screen.getByRole("button", { name: /Install/ })).toHaveTextContent("Installv0.10.0");
  });

  it("labels nightly builds 'nightly' in Download, Downloading and Install", () => {
    const version = "0.13.0-nightly.20260812.1";
    showStatus({ state: "available", version });
    const { unmount } = render(<UpdateButton />);
    expect(screen.getByRole("button", { name: /Download/ })).toHaveTextContent("Downloadnightly");
    showStatus({ state: "downloading", percent: 7 });
    expect(screen.getByRole("status")).toHaveTextContent("nightly · 7%");
    showStatus({ state: "downloaded", version, installWhenIdle: false });
    expect(screen.getByRole("button", { name: /Install/ })).toHaveTextContent("Installnightly");
    unmount();
  });

  it("shows Retry update with friendly copy for a failure", async () => {
    showStatus({ state: "error", message: "ENOSPC: no space left on device", failedOperation: "check" });
    render(<UpdateButton />);
    const retry = screen.getByRole("button", { name: "Retry update" });
    await userEvent.hover(retry);
    expect(await screen.findByText("Not enough disk space")).toBeInTheDocument();
  });

  it("shows the armed state and cancels the scheduled install from its menu", async () => {
    showStatus({ state: "downloaded", version: "0.10.0", installWhenIdle: true });
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: "Installs when idle" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel scheduled install" }));
    expect(app.cancelInstallWhenIdle).toHaveBeenCalledOnce();
  });

  it("renders nothing outside the desktop shell", () => {
    vi.stubGlobal("desktopBridge", undefined);
    const { container } = render(<UpdateButton />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Up to date flash", () => {
  it("flashes after a user-started check finds nothing, then returns to rest", async () => {
    vi.useFakeTimers();
    app.checkForUpdates.mockImplementation(async () => {
      useUpdateStore.getState().setStatus({ state: "not-available", version: "0.9.0" });
      return { state: "not-available", version: "0.9.0" };
    });
    render(<UpdateButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Up to date");
    act(() => vi.advanceTimersByTime(UP_TO_DATE_FLASH_MS));
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("never flashes for a background check", () => {
    render(<UpdateButton />);
    showStatus({ state: "checking" }, { state: "not-available", version: "0.9.0" });
    expect(screen.queryByText("Up to date")).toBeNull();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });
});

describe("Install", () => {
  beforeEach(() => showStatus({ state: "downloaded", version: "0.10.0", installWhenIdle: false }));

  it("installs without a dialog when the desktop starts the install", async () => {
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    await waitFor(() => expect(app.installUpdate).toHaveBeenCalledOnce());
    expect(app.installUpdate).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("dialog", { name: "Install update" })).toBeNull();
  });

  it("asks first with one agent running and arms install when they finish", async () => {
    app.installUpdate.mockResolvedValue(busy(1));
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    const dialog = await screen.findByRole("dialog", { name: "Install update" });
    expect(dialog).toHaveTextContent("0.10.0");
    expect(dialog).toHaveTextContent("1 agent is running. Installing restarts Mcode. Running work continues after it restarts.");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "When they finish" })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole("button", { name: "When they finish" }));
    expect(app.installWhenIdle).toHaveBeenCalledOnce();
    expect(app.installUpdate).toHaveBeenCalledOnce();
  });

  it("sends a confirmed install from Restart now", async () => {
    app.installUpdate.mockResolvedValueOnce(busy(3));
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    const dialog = await screen.findByRole("dialog", { name: "Install update" });
    expect(dialog).toHaveTextContent("3 agents are running.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Restart now" }));
    expect(app.installUpdate.mock.calls).toEqual([[undefined], [{ confirmed: true }]]);
  });

  it("asks first when the desktop could not read the agent count", async () => {
    app.installUpdate.mockResolvedValue(busy(null));
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    expect(await screen.findByRole("dialog", { name: "Install update" })).toHaveTextContent("Agents may be running. Installing restarts Mcode. "
      + "Running work continues after it restarts.");
  });
});

describe("Install on a nightly build", () => {
  const nightly = "0.15.0-nightly.20261020.300";
  const installBlocked: UpdateStatus = {
    state: "error",
    message: "Update installation blocked: no downloaded update is ready to install",
    failedOperation: "install",
  };
  const refused: InstallUpdateResult = { kind: "refused", message: installBlocked.message };

  beforeEach(() => showStatus({ state: "downloaded", version: nightly, installWhenIdle: false }));

  const clickInstall = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Install/ }));
    });
  };

  it("installs on click", async () => {
    render(<UpdateButton />);
    expect(screen.getByRole("button", { name: /Install/ })).toHaveTextContent("Installnightly");
    await clickInstall();
    expect(app.installUpdate).toHaveBeenCalledOnce();
  });

  it("shows Installing and ignores repeat clicks until the desktop answers", async () => {
    let finishInstall: ((result: InstallUpdateResult) => void) | undefined;
    app.installUpdate.mockImplementation(() => new Promise<InstallUpdateResult>((resolve) => { finishInstall = resolve; }));
    render(<UpdateButton />);
    const pill = screen.getByRole("button", { name: /Install/ });

    await act(async () => {
      fireEvent.click(pill);
      fireEvent.click(pill);
    });

    expect(screen.getByRole("status", { name: "Installing update" })).toHaveTextContent("Installing");
    expect(screen.queryByRole("button")).toBeNull();
    expect(app.installUpdate).toHaveBeenCalledOnce();

    await act(async () => finishInstall?.(STARTED));
    expect(screen.getByRole("button", { name: /Install/ })).toBeInTheDocument();
  });

  it("shows Retry update when the desktop refuses to install", async () => {
    app.installUpdate.mockResolvedValue(refused);
    app.getUpdateStatus.mockResolvedValue(installBlocked);
    render(<UpdateButton />);

    await clickInstall();

    expect(screen.getByRole("button", { name: "Retry update" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Installing update" })).toBeNull();
  });

  it("shows Retry update when the install request itself fails", async () => {
    app.installUpdate.mockRejectedValue(new Error("ipc channel closed"));
    app.getUpdateStatus.mockResolvedValue({ state: "downloaded", version: nightly, installWhenIdle: false });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<UpdateButton />);

    await clickInstall();

    expect(screen.getByRole("button", { name: "Retry update" })).toBeInTheDocument();
  });

  it("shows Retry update when a refused install's status cannot be read", async () => {
    app.installUpdate.mockResolvedValue(refused);
    app.getUpdateStatus.mockRejectedValue(new Error("ipc channel closed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<UpdateButton />);

    await clickInstall();

    expect(screen.getByRole("button", { name: "Retry update" })).toBeInTheDocument();
  });

  it("shows Installing and then the failure after Restart now", async () => {
    let finishInstall: ((result: InstallUpdateResult) => void) | undefined;
    app.installUpdate
      .mockResolvedValueOnce(busy(2))
      .mockImplementationOnce(() => new Promise<InstallUpdateResult>((resolve) => { finishInstall = resolve; }));
    app.getUpdateStatus.mockResolvedValue(installBlocked);
    render(<UpdateButton />);
    await clickInstall();
    const dialog = await screen.findByRole("dialog", { name: "Install update" });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Restart now" }));
    });
    expect(screen.getByRole("status", { name: "Installing update" })).toBeInTheDocument();

    await act(async () => finishInstall?.(refused));
    expect(screen.getByRole("button", { name: "Retry update" })).toBeInTheDocument();
  });
});

describe("Retry", () => {
  it.each([
    ["check", "checkForUpdates"],
    ["download", "downloadUpdate"],
  ] as const)("repeats a failed %s", async (failedOperation, method) => {
    showStatus({ state: "error", message: "boom", failedOperation });
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: "Retry update" }));
    expect(app[method]).toHaveBeenCalledOnce();
  });

  it("repeats a failed install through the desktop's agent check", async () => {
    showStatus(
      { state: "downloaded", version: "0.10.0", installWhenIdle: false },
      { state: "error", message: "Update installation blocked: busy", failedOperation: "install" },
    );
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: "Retry update" }));
    await waitFor(() => expect(app.installUpdate).toHaveBeenCalledWith(undefined));
  });
});

describe("ReleaseNotesCard", () => {
  it("opens on hover of Download and stays out of the way of its click", async () => {
    showStatus({ state: "available", version: "0.10.0", releaseNotes: "- Faster startup" });
    render(<UpdateButton />);
    const download = screen.getByRole("button", { name: /Download/ });
    await userEvent.hover(download);
    expect(await screen.findByTestId("release-notes-card")).toHaveTextContent("Faster startup");
    await userEvent.click(download);
    expect(app.downloadUpdate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("release-notes-card")).toBeInTheDocument();
  });

  it("opens on keyboard focus, closes on Escape, and downloads on Enter", async () => {
    showStatus({ state: "available", version: "0.10.0", releaseNotes: "- Faster startup" });
    render(<UpdateButton />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /Download/ })).toHaveFocus();
    expect(await screen.findByTestId("release-notes-card")).toHaveTextContent("Faster startup");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("release-notes-card")).toBeNull());
    await userEvent.keyboard("{Enter}");
    expect(app.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("stays closed when Escape from inside the card returns focus to the trigger", async () => {
    showStatus({ state: "available", version: "0.10.0", releaseNotes: "- Faster startup" });
    render(<UpdateButton />);
    await userEvent.tab();
    await screen.findByTestId("release-notes-card");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Full release notes" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: /Download/ })).toHaveFocus());
    await waitFor(() => expect(screen.queryByTestId("release-notes-card")).toBeNull());
  });

  it("renders script and markdown links as inert text", async () => {
    const notes = '<ul><li>Fix<script>window.pwned = true</script></li></ul>\n- See [docs](javascript:alert(1))';
    const { container } = render(<ReleaseNotesCard version="0.10.0" notes={notes} />);
    expect(container.querySelector("script, a, img")).toBeNull();
    expect(screen.getByRole("listitem")).toHaveTextContent("Fix");
    await userEvent.click(screen.getByRole("button", { name: "Full release notes" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/mzeey-empire/mcode/releases/tag/v0.10.0");
  });
});
