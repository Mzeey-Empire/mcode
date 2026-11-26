import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the refs exist inside the vi.mock factory below.
const { saves, persisted } = vi.hoisted(() => ({
  saves: [] as { partial: unknown; resolve: (failure?: string) => void }[],
  persisted: {
    graphics: { hardwareAcceleration: false } as Record<string, unknown>,
    diagnostics: {} as Record<string, unknown>,
  },
}));

vi.mock("@/stores/settingsStore", () => {
  const state = {
    get settings() {
      return persisted;
    },
    update: (partial: unknown) =>
      new Promise<string | void>((resolve) => {
        saves.push({ partial, resolve });
      }),
  };
  return { useSettingsStore: (selector: (s: typeof state) => unknown) => selector(state) };
});

import { TroubleshootingSection } from "../TroubleshootingSection";

describe("TroubleshootingSection diagnostics recording", () => {
  beforeEach(() => {
    saves.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    persisted.diagnostics = {};
  });

  it("defaults on and saves the setting when switched off", async () => {
    render(<TroubleshootingSection />);
    const toggle = screen.getByRole("switch", { name: "Troubleshooting logs" });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { recording: false } }]));
  });

  it("reads a saved off setting and saves it back on", async () => {
    persisted.diagnostics = { recording: false };
    render(<TroubleshootingSection />);
    const toggle = screen.getByRole("switch", { name: "Troubleshooting logs" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { recording: true } }]));
  });
});

describe("TroubleshootingSection hardware acceleration", () => {
  const relaunch = vi.fn(() => Promise.resolve());

  function stubDesktopBridge(runningEnabled: boolean): void {
    vi.stubGlobal("desktopBridge", {
      app: {
        getHardwareAcceleration: () => Promise.resolve({ enabled: runningEnabled }),
        relaunch,
      },
    });
  }

  beforeEach(() => {
    saves.length = 0;
    relaunch.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    persisted.graphics = { hardwareAcceleration: false };
  });

  it("is absent without the desktop bridge", () => {
    render(<TroubleshootingSection />);
    expect(screen.queryByRole("switch", { name: "Hardware acceleration" })).toBeNull();
  });

  it("saves the setting when toggled", async () => {
    stubDesktopBridge(false);
    render(<TroubleshootingSection />);
    fireEvent.click(await screen.findByRole("switch", { name: "Hardware acceleration" }));
    await waitFor(() =>
      expect(saves.map((save) => save.partial)).toEqual([{ graphics: { hardwareAcceleration: true } }]),
    );
  });

  it("offers a restart that relaunches when the saved value differs from the running one", async () => {
    persisted.graphics = { hardwareAcceleration: true };
    stubDesktopBridge(false);
    render(<TroubleshootingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("offers no restart when the saved value matches the running one", async () => {
    persisted.graphics = { hardwareAcceleration: true };
    stubDesktopBridge(true);
    render(<TroubleshootingSection />);
    expect(await screen.findByRole("switch", { name: "Hardware acceleration" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });
});

describe("TroubleshootingSection crash dumps", () => {
  const relaunch = vi.fn(() => Promise.resolve());
  const directory = "/home/dev/.config/Mcode/Crashpad";
  const dumps = { enabledAtLaunch: false, directory, totalBytes: 2_621_440 };
  const getCrashDumps = vi.fn();
  const deleteCrashDumps = vi.fn();

  function stubDesktopBridge(app: Record<string, unknown> = { getCrashDumps, deleteCrashDumps, relaunch }): void {
    vi.stubGlobal("desktopBridge", { app });
  }

  async function toggleAndResolveSettingsSave(toggle: HTMLElement, failure?: string): Promise<void> {
    fireEvent.click(toggle);
    await act(async () => {
      saves[0]?.resolve(failure);
    });
  }

  beforeEach(() => {
    saves.length = 0;
    relaunch.mockClear();
    getCrashDumps.mockReset().mockResolvedValue(dumps);
    deleteCrashDumps.mockReset().mockResolvedValue({ ...dumps, totalBytes: 0 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    persisted.diagnostics = {};
  });

  it("is off by default and saves the setting when switched on", async () => {
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    const toggle = await screen.findByRole("switch", { name: "Crash dumps" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { crashDumps: true } }]));
  });

  it("is absent when the bridge lacks any crash dump call", () => {
    stubDesktopBridge({ getCrashDumps, relaunch });
    const { unmount } = render(<TroubleshootingSection />);
    expect(screen.queryByRole("switch", { name: "Crash dumps" })).toBeNull();
    unmount();

    stubDesktopBridge({ getCrashDumps, deleteCrashDumps });
    render(<TroubleshootingSection />);
    expect(screen.queryByRole("switch", { name: "Crash dumps" })).toBeNull();
  });

  it("offers a restart that relaunches when the saved value differs from the launch value", async () => {
    persisted.diagnostics = { crashDumps: true };
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("offers a restart after switching off a setting that was on at launch", async () => {
    getCrashDumps.mockResolvedValue({ ...dumps, enabledAtLaunch: true });
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    expect(await screen.findByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("offers no restart when the saved value matches the launch value", async () => {
    persisted.diagnostics = { crashDumps: true };
    getCrashDumps.mockResolvedValue({ ...dumps, enabledAtLaunch: true });
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("2.5 MB");
    expect(screen.getByRole("switch", { name: "Crash dumps" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("shows the dump folder and size once the state loads", async () => {
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    expect(screen.queryByLabelText(directory)).toBeNull();

    expect(await screen.findByText("2.5 MB")).toBeInTheDocument();
    expect(screen.getByLabelText(directory)).toBeInTheDocument();
  });

  it("asks before deleting when switched off with dumps saved, and Delete removes them", async () => {
    persisted.diagnostics = { crashDumps: true };
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("2.5 MB");

    await toggleAndResolveSettingsSave(screen.getByRole("switch", { name: "Crash dumps" }));
    expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { crashDumps: false } }]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete saved crash dumps?");
    expect(dialog).toHaveTextContent(`2.5 MB of crash dumps are saved in ${directory}`);
    expect(deleteCrashDumps).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("0 B")).toBeInTheDocument();
    expect(deleteCrashDumps).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("2.5 MB")).toBeNull();
  });

  it("keeps the dumps when Keep is chosen", async () => {
    persisted.diagnostics = { crashDumps: true };
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("2.5 MB");

    await toggleAndResolveSettingsSave(screen.getByRole("switch", { name: "Crash dumps" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteCrashDumps).not.toHaveBeenCalled();
    expect(screen.getByText("2.5 MB")).toBeInTheDocument();
  });

  it("opens no dialog when switched off with no dumps saved", async () => {
    persisted.diagnostics = { crashDumps: true };
    getCrashDumps.mockResolvedValue({ ...dumps, totalBytes: 0 });
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("0 B");

    await toggleAndResolveSettingsSave(screen.getByRole("switch", { name: "Crash dumps" }));
    expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { crashDumps: false } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens no dialog when switched on with dumps already saved", async () => {
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("2.5 MB");

    await toggleAndResolveSettingsSave(screen.getByRole("switch", { name: "Crash dumps" }));
    expect(saves.map((save) => save.partial)).toEqual([{ diagnostics: { crashDumps: true } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens no dialog when the switch-off save fails", async () => {
    persisted.diagnostics = { crashDumps: true };
    stubDesktopBridge();
    render(<TroubleshootingSection />);
    await screen.findByText("2.5 MB");

    await toggleAndResolveSettingsSave(screen.getByRole("switch", { name: "Crash dumps" }), "Could not save settings");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("TroubleshootingSection page", () => {
  it("shows the troubleshooting logs row", () => {
    render(<TroubleshootingSection />);
    expect(screen.getByRole("switch", { name: "Troubleshooting logs" })).toBeInTheDocument();
  });
});
