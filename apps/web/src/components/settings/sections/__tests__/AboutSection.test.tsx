import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the refs exist inside the vi.mock factory below.
const { saves, persisted } = vi.hoisted(() => ({
  saves: [] as { partial: unknown; resolve: () => void }[],
  persisted: {
    updates: { channel: "stable" } as Record<string, unknown>,
    graphics: { hardwareAcceleration: false } as Record<string, unknown>,
    diagnostics: {} as Record<string, unknown>,
  },
}));

// Saves stay pending until the test resolves them, and never change `settings`, like the real server round trip.
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

import { AboutSection } from "../AboutSection";

describe("AboutSection release line", () => {
  beforeEach(() => {
    saves.length = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ends on Stable when the arrow keys go to Nightly and back before the first save lands", async () => {
    render(<AboutSection />);
    const stable = screen.getByRole("radio", { name: "Stable" });
    stable.focus();
    const group = screen.getByRole("radiogroup", { name: (_, el) => el.contains(stable) });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });

    // The reversal waits behind the pending save so the updater sees the switches in order.
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ updates: { channel: "nightly" } }]));
    saves[0]?.resolve();
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]?.partial).toEqual({ updates: { channel: "stable" } });
  });

  it("keeps the latest request when an earlier switch to the same line settles first", async () => {
    render(<AboutSection />);
    const stable = screen.getByRole("radio", { name: "Stable" });
    stable.focus();
    const group = screen.getByRole("radiogroup", { name: (_, el) => el.contains(stable) });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    await waitFor(() => expect(saves).toHaveLength(1));

    // The first Nightly settling must not forget that the third request, also Nightly, is still the latest.
    saves[0]?.resolve();
    await waitFor(() => expect(saves).toHaveLength(2));
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    for (const count of [3, 4]) {
      saves[count - 2]?.resolve();
      await waitFor(() => expect(saves).toHaveLength(count));
    }
    expect(saves.map((save) => save.partial)).toEqual(
      ["nightly", "stable", "nightly", "stable"].map((channel) => ({ updates: { channel } })),
    );
  });
});

describe("AboutSection moved rows", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    vi.stubGlobal("desktopBridge", {
      app: { getHardwareAcceleration: () => Promise.resolve({ enabled: false }), relaunch: vi.fn() },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no longer shows the rows that moved to Troubleshooting and Providers", async () => {
    render(<AboutSection />);
    await screen.findByText("Version");
    await Promise.resolve();
    for (const name of ["Troubleshooting logs", "Hardware acceleration", "Provider CLI checks", "Check for CLI updates"]) {
      expect(screen.queryByRole("switch", { name })).toBeNull();
    }
  });
});
