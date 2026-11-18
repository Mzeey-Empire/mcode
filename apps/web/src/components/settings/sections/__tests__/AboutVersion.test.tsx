import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { AGENT_COUNT_DEADLINE_MS } from "@/features/updates/active-agent-count";
import { releaseNotesUrl } from "@/features/updates/update-button-state";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUpdateStore } from "@/stores/updateStore";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import { AboutSection } from "../AboutSection";
import { HOLD_TO_RESTART_MS } from "../HoldToRestartButton";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const app = {
  checkForUpdates: vi.fn(() => Promise.resolve<UpdateStatus>({ state: "not-available", version: "0.16.0" })),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  installUpdate: vi.fn(() => Promise.resolve(true)),
  installWhenIdle: vi.fn(() => Promise.resolve()),
  cancelInstallWhenIdle: vi.fn(() => Promise.resolve()),
  getUpdateStatus: vi.fn(() => Promise.resolve<UpdateStatus>({ state: "idle" })),
};
const openExternalUrl = vi.fn(() => Promise.resolve());
const getActiveAgentCount = vi.mocked(mockTransport.getActiveAgentCount);

const READY: UpdateStatus = { state: "downloaded", version: "0.17.0", installWhenIdle: false };

function setStatuses(...statuses: UpdateStatus[]) {
  for (const status of statuses) useUpdateStore.getState().setStatus(status);
}

function setRunningAgents(count: number) {
  useThreadStore.setState({ runningThreadIds: new Set(Array.from({ length: count }, (_, index) => `thread-${index}`)) });
}

function hintText(): string | null | undefined {
  return document.querySelector('[data-setting-id="about.version"] p')?.textContent;
}

function actionNames(): string[] {
  const row = document.querySelector('[data-setting-id="about.version"]');
  return [...(row?.querySelectorAll("button") ?? [])]
    .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "")
    .filter((name) => !name.startsWith("What's new"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getActiveAgentCount.mockReset().mockResolvedValue(0);
  useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true, update: vi.fn(async () => {}) });
  useUpdateStore.setState({ version: "0.16.0", stage: "stable", status: { state: "idle" }, pendingVersion: null });
  setRunningAgents(0);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  vi.stubGlobal("desktopBridge", { app, openExternalUrl });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("About version row status", () => {
  // Fails if a state shows the wrong sentence or offers the wrong next step.
  it.each<[string, UpdateStatus[], string, string[]]>([
    ["idle", [{ state: "idle" }], "Up to date.", ["Check now"]],
    ["not available", [{ state: "not-available", version: "0.16.0" }], "Up to date.", ["Check now"]],
    ["checking", [{ state: "checking" }], "Checking for updates.", ["Check now"]],
    ["available", [{ state: "available", version: "0.17.0" }], "v0.17.0 is available.", ["Download"]],
    ["downloading", [{ state: "available", version: "0.17.0" }, { state: "downloading", percent: 42.4 }], "Downloading v0.17.0, 42%.", []],
    ["ready", [READY], "v0.17.0 is ready. Restart Mcode to install it.", ["Restart"]],
    ["installs when idle", [{ ...READY, installWhenIdle: true }], "Installs v0.17.0 when your agents finish.", ["Cancel"]],
    [
      "failed",
      [{ state: "error", message: "net::ERR_NAME_NOT_RESOLVED", failedOperation: "check" }],
      "Couldn't reach the update server. Check your internet connection and try again.",
      ["Retry"],
    ],
  ])("%s shows its sentence and action", (_name, statuses, hint, actions) => {
    setStatuses(...statuses);
    render(<AboutSection />);
    expect(hintText()).toBe(hint);
    expect(actionNames()).toEqual(actions);
  });

  // Fails if Check now stays clickable while a check runs, inviting a second check.
  it("marks Check now unavailable while checking", () => {
    setStatuses({ state: "checking" });
    render(<AboutSection />);
    expect(screen.getByRole("button", { name: "Check now" }).getAttribute("aria-disabled")).toBe("true");
  });

  // Fails if turning off automatic checks still claims the app is up to date.
  it("says automatic checks are off when the interval is Off", () => {
    useSettingsStore.setState({ settings: { ...getDefaultSettings(), updates: { ...getDefaultSettings().updates, checkInterval: "never" } } });
    render(<AboutSection />);
    expect(hintText()).toBe("Automatic checks are off.");
  });

  // Fails if a status change is not announced to screen readers.
  it("announces status changes through the status line", () => {
    render(<AboutSection />);
    expect(screen.getByRole("status").textContent).toBe("Up to date");
    act(() => setStatuses({ state: "available", version: "0.17.0" }));
    expect(screen.getByRole("status").textContent).toBe("v0.17.0 is available");
  });
});

describe("About version row What's new", () => {
  // Fails if the link shows with nothing pending, or opens the notes for the wrong version.
  it("shows only while an update is pending and opens that version's notes", () => {
    render(<AboutSection />);
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
    act(() => setStatuses({ state: "available", version: "0.17.0" }));
    fireEvent.click(screen.getByRole("button", { name: "What's new in v0.17.0" }));
    expect(openExternalUrl).toHaveBeenCalledWith(releaseNotesUrl("0.17.0"));
  });
});

describe("About version row download", () => {
  it("shows the status read back when the download call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    app.downloadUpdate.mockRejectedValueOnce(new Error("ipc closed"));
    app.getUpdateStatus.mockResolvedValueOnce({ state: "error", message: "net::ERR_NAME_NOT_RESOLVED", failedOperation: "download" });
    setStatuses({ state: "available", version: "0.17.0" });
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(actionNames()).toEqual(["Retry"]);
  });
});

describe("About version row restart", () => {
  // Fails if a plain click restarts while agents run, or a short press restarts.
  it("restarts after a 1200ms hold with agents running, not after 1100ms", () => {
    setRunningAgents(2);
    setStatuses(READY);
    render(<AboutSection />);
    expect(hintText()).toBe("v0.17.0 is ready. Restarting ends 2 agents.");
    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 2 running agents." });

    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(1_100));
    fireEvent.pointerUp(hold);
    act(() => vi.advanceTimersByTime(HOLD_TO_RESTART_MS));
    expect(app.installUpdate).not.toHaveBeenCalled();

    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(HOLD_TO_RESTART_MS));
    expect(app.installUpdate).toHaveBeenCalledTimes(1);
    expect(hold.textContent).toContain("Restarting");
  });

  // Fails if keyboard users cannot restart, or a held key still commits after focus leaves.
  it("restarts on a held Space and cancels on blur", () => {
    setRunningAgents(1);
    setStatuses(READY);
    render(<AboutSection />);
    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 1 running agent." });

    fireEvent.keyDown(hold, { key: " " });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.blur(hold);
    act(() => vi.advanceTimersByTime(HOLD_TO_RESTART_MS));
    expect(app.installUpdate).not.toHaveBeenCalled();

    fireEvent.keyDown(hold, { key: " " });
    act(() => vi.advanceTimersByTime(HOLD_TO_RESTART_MS));
    expect(app.installUpdate).toHaveBeenCalledTimes(1);
  });

  // Fails if "Install when they finish" does not defer the install.
  it("defers the install until agents finish", () => {
    setRunningAgents(1);
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install when they finish" }));
    expect(app.installWhenIdle).toHaveBeenCalledTimes(1);
    expect(app.installUpdate).not.toHaveBeenCalled();
  });

  // Fails if Restart needs a hold when nothing would be lost, or skips the server re-check.
  it("restarts on a click when the server counts no agents", async () => {
    getActiveAgentCount.mockResolvedValue(0);
    setStatuses(READY);
    render(<AboutSection />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getActiveAgentCount).toHaveBeenCalledTimes(2);
    expect(app.installUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("About version row server agent count", () => {
  // Fails if the row trusts only this window's threads and offers a plain Restart over agents elsewhere.
  it("asks for a hold when the server counts agents this window has not loaded", async () => {
    getActiveAgentCount.mockResolvedValue(2);
    setStatuses(READY);
    render(<AboutSection />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 2 running agents." });
    fireEvent.click(hold);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate).not.toHaveBeenCalled();
  });

  // Fails if a plain Restart installs on a stale count after agents started elsewhere.
  it("switches to hold when the click's re-check finds agents", async () => {
    getActiveAgentCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    setStatuses(READY);
    render(<AboutSection />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Hold to restart. Ends 1 running agent." })).toBeTruthy();
  });

  // Fails if an unreadable or late count is read as "no agents" and installs.
  it.each([
    ["rejects", () => getActiveAgentCount.mockRejectedValueOnce(new Error("socket closed"))],
    ["misses the deadline", () => getActiveAgentCount.mockReturnValueOnce(new Promise<number>(() => {}))],
  ])("does not install when the re-check %s", async (_name, failRecheck) => {
    getActiveAgentCount.mockResolvedValueOnce(0);
    setStatuses(READY);
    render(<AboutSection />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    failRecheck();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(AGENT_COUNT_DEADLINE_MS));
    expect(app.installUpdate).not.toHaveBeenCalled();
    expect(hintText()).toBe("v0.17.0 is ready. Agents may be running.");
    expect(screen.getByRole("status").textContent).toBe("v0.17.0 is ready. Agents may be running.");
  });

  // Fails if Retry after a failed install restarts over agents the re-check finds.
  it("re-checks the server before retrying a failed install", async () => {
    getActiveAgentCount.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    setStatuses({ state: "error", message: "Update installation blocked: busy", failedOperation: "install" });
    render(<AboutSection />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Hold to restart. Ends 3 running agents." })).toBeTruthy();
  });
});

describe("About version row label", () => {
  // Fails if a dev build loses its stage label next to the version.
  it("names a dev build next to its version", () => {
    useUpdateStore.setState({ stage: "dev" });
    render(<AboutSection />);
    expect(screen.getByText("v0.16.0").nextElementSibling?.textContent).toBe("Dev");
  });

  it("shows only the version for a stable build", () => {
    render(<AboutSection />);
    expect(screen.getByText("v0.16.0").nextElementSibling).toBeNull();
  });
});
