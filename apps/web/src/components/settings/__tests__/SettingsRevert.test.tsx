import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings, type Settings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSettingsLocation } from "@/stores/settingsLocationStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTerminalSettingsStore } from "@/features/terminal/settings/terminalSettingsStore";
import type { SettingsSection } from "../settings-sections";
import { SettingsView } from "../SettingsView";
import { mergeSettings, seedProviderAvailability } from "./settings-fixtures";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function serveSettingsWrites() {
  vi.mocked(mockTransport.updateSettings).mockReset().mockImplementation(async (patch) => mergeSettings(useSettingsStore.getState().settings, patch));
}

function themeOf(settings: Settings, theme: Settings["appearance"]["theme"]): Settings {
  return { ...settings, appearance: { ...settings.appearance, theme } };
}

async function flush() {
  await act(async () => {});
}

function openPage(page: SettingsSection) {
  act(() => useSettingsLocation.getState().openPage(page));
}

async function chooseDark() {
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  await flush();
}

function revertButton() {
  return screen.queryByRole("button", { name: /^Revert \d+ changes?$/ });
}

async function tooltipOf(button: HTMLElement) {
  fireEvent.focus(button);
  fireEvent.pointerEnter(button);
  fireEvent.mouseEnter(button);
  return (await screen.findByText(/Puts back/)).textContent;
}

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1" });
  useTerminalSettingsStore.setState({ workspaceOverride: null, pending: false, error: null });
  useSettingsLocation.getState().openPage("general");
  seedProviderAvailability();
  serveSettingsWrites();
  vi.mocked(mockTransport.terminalPreferencesUpdate).mockClear();
  vi.mocked(mockTransport.terminalWorkspacePreferencesReset).mockClear();
  vi.mocked(mockTransport.terminalProfileList).mockResolvedValue({ certified: [], custom: [] });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Settings Revert", () => {
  it("puts back a changed theme in one write and focuses the page heading", async () => {
    render(<SettingsView />);
    expect(revertButton()).toBeNull();
    await chooseDark();

    const button = screen.getByRole("button", { name: "Revert 1 change" });
    expect(await tooltipOf(button)).toBe("Puts back Theme");
    fireEvent.click(button);
    await flush();

    expect(vi.mocked(mockTransport.updateSettings).mock.calls.at(-1)?.[0]).toEqual({ appearance: { theme: "system" } });
    expect(mockTransport.updateSettings).toHaveBeenCalledTimes(2);
    expect(revertButton()).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Reverted 1 change.");
  });

  it("leaves a value another window changed afterwards alone", async () => {
    render(<SettingsView />);
    await chooseDark();
    act(() => useSettingsStore.getState()._applyPush(themeOf(useSettingsStore.getState().settings, "light")));

    expect(revertButton()).toBeNull();
    expect(mockTransport.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps a change the terminal write could not put back and focuses the button", async () => {
    openPage("terminal");
    render(<SettingsView />);
    await flush();
    await act(async () => {
      await useTerminalSettingsStore.getState().updatePreferences({ presentation: { fontSize: "xl" } });
      await useSettingsStore.getState().update({ appearance: { theme: "dark" } });
    });
    vi.mocked(mockTransport.terminalPreferencesUpdate).mockRejectedValueOnce(new Error("Terminal settings are locked."));

    fireEvent.click(screen.getByRole("button", { name: "Revert 2 changes" }));
    await flush();

    expect(vi.mocked(mockTransport.updateSettings).mock.calls.at(-1)?.[0]).toEqual({ appearance: { theme: "system" } });
    expect(vi.mocked(mockTransport.terminalPreferencesUpdate).mock.calls.at(-1)?.[0]).toEqual({ presentation: { fontSize: "sm" } });
    const button = screen.getByRole("button", { name: "Revert 1 change" });
    expect(button).toHaveFocus();
    expect(await tooltipOf(button)).toBe("Could not put back Font size: Terminal settings are locked. Puts back Font size");
  });

  it("puts back the project default profile on the project it was changed in", async () => {
    openPage("terminal");
    render(<SettingsView />);
    await flush();
    await act(async () => {
      await useTerminalSettingsStore.getState().setWorkspaceDefault("workspace-1", "automatic");
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();

    expect(mockTransport.terminalWorkspacePreferencesReset).toHaveBeenCalledWith("workspace-1");
    expect(revertButton()).toBeNull();
  });

  it("forgets the visit when another page opens or Settings closes", async () => {
    const view = render(<SettingsView />);
    await chooseDark();
    openPage("threads");
    openPage("general");
    expect(revertButton()).toBeNull();

    await chooseDark();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    await flush();
    expect(revertButton()).not.toBeNull();
    view.unmount();
    render(<SettingsView />);
    expect(revertButton()).toBeNull();
  });

  it("does not count a write that lands after its visit ended", async () => {
    render(<SettingsView />);
    let land: (settings: Settings) => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce(() => new Promise((resolve) => {
      land = resolve;
    }));
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    openPage("threads");
    await act(async () => land(themeOf(useSettingsStore.getState().settings, "dark")));

    expect(useSettingsStore.getState().settings.appearance.theme).toBe("dark");
    expect(revertButton()).toBeNull();
  });

  it("hides on search results and shows a change made from one after the search clears", async () => {
    render(<SettingsView />);
    act(() => useSettingsLocation.getState().setQuery("theme"));
    expect(await screen.findByRole("heading", { name: 'Best match for "theme"' })).toBeInTheDocument();
    await chooseDark();
    expect(revertButton()).toBeNull();

    act(() => useSettingsLocation.getState().setQuery(""));
    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
  });

  it("keeps a change made from results when its hit opens another page", async () => {
    render(<SettingsView />);
    act(() => useSettingsLocation.getState().setQuery("scrollback"));
    const slider = await screen.findByRole("slider", { name: "Scrollback lines" });
    fireEvent.change(slider, { target: { value: "2000" } });
    fireEvent.mouseUp(slider);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /^Go to Scrollback lines in Terminal/ }));
    await flush();

    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
  });

  it("lets another window's change win while a local write to a different setting is in flight", async () => {
    render(<SettingsView />);
    await chooseDark();
    let land: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => new Promise((resolve) => {
      land = () => resolve(mergeSettings(useSettingsStore.getState().settings, patch));
    }));
    let notificationsWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      notificationsWrite = useSettingsStore.getState().update({ notifications: { enabled: false } });
    });
    act(() => useSettingsStore.getState()._applyPush(themeOf(useSettingsStore.getState().settings, "light")));
    await act(async () => {
      land();
      await notificationsWrite;
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();

    expect(vi.mocked(mockTransport.updateSettings).mock.calls.at(-1)?.[0]).toEqual({ notifications: { enabled: true } });
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("light");
  });

  it("claims a setting its own write changed while another local write is in flight", async () => {
    render(<SettingsView />);
    let land: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => new Promise((resolve) => {
      land = () => resolve(mergeSettings(useSettingsStore.getState().settings, patch));
    }));
    let notificationsWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      notificationsWrite = useSettingsStore.getState().update({ notifications: { enabled: false } });
    });
    await chooseDark();

    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
    // The in-flight set is module state; a write left pending would block Revert in later tests.
    await act(async () => {
      land();
      await notificationsWrite;
    });
  });

  it("does not overwrite an outside change that lands between two Revert writes", async () => {
    openPage("terminal");
    render(<SettingsView />);
    await flush();
    await act(async () => {
      await useTerminalSettingsStore.getState().updatePreferences({ presentation: { fontSize: "xl" } });
      await useSettingsStore.getState().update({ appearance: { theme: "dark" } });
    });
    vi.mocked(mockTransport.terminalPreferencesUpdate).mockClear();
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => {
      const settings = useSettingsStore.getState().settings;
      const pushed = { ...settings, terminal: { ...settings.terminal, presentation: { ...settings.terminal.presentation, fontSize: "lg" as const } } };
      useSettingsStore.getState()._applyPush(pushed);
      return Promise.resolve(mergeSettings(pushed, patch));
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 2 changes" }));
    await flush();

    expect(mockTransport.terminalPreferencesUpdate).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.terminal.presentation.fontSize).toBe("lg");
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("system");
  });

  it("switches the running updater back when it puts back the release line", async () => {
    const applyReleaseLine = vi.fn(() => Promise.resolve({ state: "idle" as const }));
    vi.stubGlobal("desktopBridge", { app: { applyReleaseLine } });
    render(<SettingsView />);
    await act(async () => {
      await useSettingsStore.getState().update({ updates: { channel: "nightly" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();

    expect(useSettingsStore.getState().settings.updates.channel).toBe("stable");
    expect(applyReleaseLine.mock.calls.at(-1)).toEqual([{ releaseLine: "stable", allowDowngrade: false }]);
    vi.unstubAllGlobals();
  });

  it("shows the restored serve URL in its input", async () => {
    openPage("providers");
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "OpenCode settings" }));
    const input = screen.getByRole("textbox", { name: "OpenCode Server URL" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "http://127.0.0.1:4096" } });
    fireEvent.blur(input);
    await flush();
    expect(useSettingsStore.getState().settings.provider.opencode.serveUrl).toBe("http://127.0.0.1:4096");

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();
    expect(input).toHaveValue("");
  });
});
