import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import { useUpdateStore } from "@/stores/updateStore";
import { ReleaseNotesCard } from "../ReleaseNotesCard";
import { UP_TO_DATE_FLASH_MS, UpdateButton } from "../UpdateButton";

const getActiveAgentCount = vi.fn<() => Promise<number>>();

vi.mock("@/transport", () => ({
  getTransport: () => ({ getActiveAgentCount }),
}));

function createApp() {
  return {
    checkForUpdates: vi.fn<() => Promise<UpdateStatus>>().mockResolvedValue({ state: "idle" }),
    downloadUpdate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    installUpdate: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
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
  getActiveAgentCount.mockReset();
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

  it("installs straight away with no agents running", async () => {
    getActiveAgentCount.mockResolvedValue(0);
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    await waitFor(() => expect(app.installUpdate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks first with one agent running and arms install when they finish", async () => {
    getActiveAgentCount.mockResolvedValue(1);
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Install update");
    expect(dialog).toHaveTextContent("0.10.0");
    expect(dialog).toHaveTextContent("1 agent is running. Installing restarts Mcode and stops them.");
    await userEvent.click(within(dialog).getByRole("button", { name: "When they finish" }));
    expect(app.installWhenIdle).toHaveBeenCalledOnce();
    expect(app.installUpdate).not.toHaveBeenCalled();
  });

  it("restarts now from the dialog with several agents running", async () => {
    getActiveAgentCount.mockResolvedValue(3);
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("3 agents are running.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Restart now" }));
    expect(app.installUpdate).toHaveBeenCalledOnce();
  });

  it("asks first when the agent count cannot be read", async () => {
    getActiveAgentCount.mockRejectedValue(new Error("socket closed"));
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: /Install/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Agents may be running.");
    expect(app.installUpdate).not.toHaveBeenCalled();
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

  it("repeats a failed install through the agent check", async () => {
    getActiveAgentCount.mockResolvedValue(0);
    showStatus(
      { state: "downloaded", version: "0.10.0", installWhenIdle: false },
      { state: "error", message: "Update installation blocked: busy", failedOperation: "install" },
    );
    render(<UpdateButton />);
    await userEvent.click(screen.getByRole("button", { name: "Retry update" }));
    await waitFor(() => expect(app.installUpdate).toHaveBeenCalledOnce());
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

  it("renders script and markdown links as inert text", async () => {
    const notes = '<ul><li>Fix<script>window.pwned = true</script></li></ul>\n- See [docs](javascript:alert(1))';
    const { container } = render(<ReleaseNotesCard version="0.10.0" notes={notes} />);
    expect(container.querySelector("script, a, img")).toBeNull();
    expect(screen.getByRole("listitem")).toHaveTextContent("Fix");
    await userEvent.click(screen.getByRole("button", { name: "Full release notes" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/mzeey-empire/mcode/releases/tag/v0.10.0");
  });
});
