import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the refs exist inside the vi.mock factory below.
const { saves, persisted } = vi.hoisted(() => ({
  saves: [] as { partial: unknown; resolve: () => void }[],
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
      new Promise<void>((resolve) => {
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

describe("TroubleshootingSection page", () => {
  it("shows the troubleshooting logs row", () => {
    render(<TroubleshootingSection />);
    expect(screen.getByRole("switch", { name: "Troubleshooting logs" })).toBeInTheDocument();
  });
});
