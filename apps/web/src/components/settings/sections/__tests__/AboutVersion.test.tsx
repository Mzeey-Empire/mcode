import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { releaseNotesUrl } from "@/features/updates/update-button-state";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUpdateStore } from "@/stores/updateStore";
import type { InstallUpdateResult, UpdateStatus } from "@/transport/desktop-bridge";
import { AboutSection } from "../AboutSection";
import { HOLD_TO_RESTART_MS } from "../HoldToRestartButton";

const app = {
  checkForUpdates: vi.fn(() => Promise.resolve<UpdateStatus>({ state: "not-available", version: "0.16.0" })),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  installUpdate: vi.fn<(request?: { readonly confirmed?: boolean }) => Promise<InstallUpdateResult>>(),
  installWhenIdle: vi.fn(() => Promise.resolve()),
  cancelInstallWhenIdle: vi.fn(() => Promise.resolve()),
  getUpdateStatus: vi.fn(() => Promise.resolve<UpdateStatus>({ state: "idle" })),
};
const openExternalUrl = vi.fn(() => Promise.resolve());

const READY: UpdateStatus = { state: "downloaded", version: "0.17.0", installWhenIdle: false };
const CONFIRMED = { confirmed: true };

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
  app.installUpdate.mockReset().mockResolvedValue({ kind: "started" });
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

  it("marks Check now unavailable while checking", () => {
    setStatuses({ state: "checking" });
    render(<AboutSection />);
    expect(screen.getByRole("button", { name: "Check now" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("says automatic checks are off when the interval is Off", () => {
    useSettingsStore.setState({ settings: { ...getDefaultSettings(), updates: { ...getDefaultSettings().updates, checkInterval: "never" } } });
    render(<AboutSection />);
    expect(hintText()).toBe("Automatic checks are off.");
  });

  it("announces status changes through the status line", () => {
    render(<AboutSection />);
    expect(screen.getByRole("status").textContent).toBe("Up to date");
    act(() => setStatuses({ state: "available", version: "0.17.0" }));
    expect(screen.getByRole("status").textContent).toBe("v0.17.0 is available");
  });
});

describe("About version row What's new", () => {
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
    expect(app.installUpdate.mock.calls).toEqual([[CONFIRMED]]);
    expect(hold.textContent).toContain("Restarting");
  });

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
    expect(app.installUpdate.mock.calls).toEqual([[CONFIRMED]]);
  });

  it("commits a second held Retry after the first install fails", async () => {
    const failed: UpdateStatus = { state: "error", message: "Update installation blocked: busy", failedOperation: "install" };
    const refused: InstallUpdateResult = { kind: "refused", message: "busy" };
    app.installUpdate.mockResolvedValueOnce(refused).mockResolvedValueOnce(refused);
    app.getUpdateStatus.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);
    setRunningAgents(1);
    setStatuses(failed);
    render(<AboutSection />);
    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 1 running agent." });

    fireEvent.pointerDown(hold, { button: 0 });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_TO_RESTART_MS));
    fireEvent.pointerUp(hold);
    fireEvent.pointerDown(hold, { button: 0 });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_TO_RESTART_MS));

    expect(app.installUpdate).toHaveBeenCalledTimes(2);
  });

  it("returns held Restart to idle when the install and the status read-back both fail", async () => {
    const failed: UpdateStatus = { state: "error", message: "Update installation blocked: busy", failedOperation: "install" };
    const refused: InstallUpdateResult = { kind: "refused", message: "busy" };
    app.installUpdate.mockResolvedValueOnce(refused).mockResolvedValueOnce(refused);
    app.getUpdateStatus.mockRejectedValueOnce(new Error("bridge gone")).mockResolvedValueOnce(failed);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setRunningAgents(1);
    setStatuses(failed);
    render(<AboutSection />);
    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 1 running agent." });

    fireEvent.pointerDown(hold, { button: 0 });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_TO_RESTART_MS));
    fireEvent.pointerUp(hold);
    expect(hold.textContent).not.toContain("Restarting");

    fireEvent.pointerDown(hold, { button: 0 });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_TO_RESTART_MS));
    expect(app.installUpdate).toHaveBeenCalledTimes(2);
  });

  it("defers the install until agents finish", () => {
    setRunningAgents(1);
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Install when they finish" }));
    expect(app.installWhenIdle).toHaveBeenCalledTimes(1);
    expect(app.installUpdate).not.toHaveBeenCalled();
  });

  it("asks the desktop to install without confirming on a plain Restart", async () => {
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate.mock.calls).toEqual([[undefined]]);
  });

  it("sends one install for a double click", async () => {
    app.installUpdate.mockReturnValueOnce(new Promise<InstallUpdateResult>(() => {}));
    setStatuses(READY);
    render(<AboutSection />);
    const restart = screen.getByRole("button", { name: "Restart" });
    fireEvent.click(restart);
    fireEvent.click(restart);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("About version row desktop agent check", () => {
  it("asks for a hold when the desktop refuses because agents are running", async () => {
    app.installUpdate.mockResolvedValueOnce({ kind: "agents-running", runningAgents: 2 });
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hintText()).toBe("v0.17.0 is ready. Restarting ends 2 agents.");

    const hold = screen.getByRole("button", { name: "Hold to restart. Ends 2 running agents." });
    fireEvent.pointerDown(hold, { button: 0 });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_TO_RESTART_MS));
    expect(app.installUpdate.mock.calls).toEqual([[undefined], [CONFIRMED]]);
  });

  it("says agents may be running when the desktop cannot count them", async () => {
    app.installUpdate.mockResolvedValueOnce({ kind: "agents-running", runningAgents: null });
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hintText()).toBe("v0.17.0 is ready. Agents may be running.");
    expect(screen.getByRole("status").textContent).toBe("v0.17.0 is ready. Agents may be running.");
    expect(screen.getByRole("button", { name: "Hold to restart. Agents may be running." })).toBeTruthy();
  });

  it("asks for a hold when a retried install finds agents", async () => {
    app.installUpdate.mockResolvedValueOnce({ kind: "agents-running", runningAgents: 3 });
    setStatuses({ state: "error", message: "Update installation blocked: busy", failedOperation: "install" });
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(app.installUpdate.mock.calls).toEqual([[undefined]]);
    expect(screen.getByRole("button", { name: "Hold to restart. Ends 3 running agents." })).toBeTruthy();
  });

  it("forgets the desktop's count when a newer update is ready", async () => {
    app.installUpdate.mockResolvedValueOnce({ kind: "agents-running", runningAgents: 2 });
    setStatuses(READY);
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => setStatuses({ ...READY, version: "0.18.0" }));
    expect(actionNames()).toEqual(["Restart"]);
  });
});

describe("About version row label", () => {
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
