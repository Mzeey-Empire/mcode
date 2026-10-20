import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the refs exist inside the vi.mock factory below.
const { saves, persisted } = vi.hoisted(() => ({
  saves: [] as { partial: unknown; resolve: () => void }[],
  persisted: { updates: { channel: "stable" } as Record<string, unknown> },
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

import { AboutSection, describeStatus } from "../AboutSection";
import { useUpdateStore } from "@/stores/updateStore";

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

describe("AboutSection update status label", () => {
  it.each([
    [{ state: "error", message: "x", failedOperation: "check" }, "Check failed"],
    [{ state: "error", message: "x", failedOperation: "download" }, "Download failed"],
    [{ state: "error", message: "x", failedOperation: "install" }, "Install failed"],
    [{ state: "downloaded", version: "0.15.0", installWhenIdle: false }, "v0.15.0 ready"],
    [{ state: "downloaded", version: "0.15.0", installWhenIdle: true }, "v0.15.0 installs when idle"],
  ] as const)("labels %o as %s", (status, label) => {
    expect(describeStatus(status)).toBe(label);
  });
});

describe("AboutSection provider CLI checks", () => {
  beforeEach(() => {
    saves.length = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    persisted.updates = { channel: "stable" };
  });

  it("defaults on and saves the setting when switched off", async () => {
    render(<AboutSection />);
    const toggle = screen.getByRole("switch", { name: "Provider CLI checks" });
    expect(toggle).toBeChecked();
    expect(screen.getByText("Ask the npm registry once a day for newer provider CLIs.")).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ updates: { providerCliChecks: false } }]));
  });

  it("reads a saved off setting and saves it back on", async () => {
    persisted.updates = { channel: "stable", providerCliChecks: false };
    render(<AboutSection />);
    const toggle = screen.getByRole("switch", { name: "Provider CLI checks" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(saves.map((save) => save.partial)).toEqual([{ updates: { providerCliChecks: true } }]));
  });
});

describe("AboutSection version row", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUpdateStore.setState({ version: "", stage: null });
  });

  it("names a dev build next to its version", () => {
    useUpdateStore.setState({ version: "0.16.0", stage: "dev" });
    render(<AboutSection />);
    expect(screen.getByText("0.16.0").parentElement?.textContent).toBe("0.16.0Dev");
  });

  it("shows only the version for a stable build", () => {
    useUpdateStore.setState({ version: "0.16.0", stage: "stable" });
    render(<AboutSection />);
    expect(screen.getByText("0.16.0").parentElement?.textContent).toBe("0.16.0");
  });
});
