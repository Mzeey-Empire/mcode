import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("releases a setting another window changed while a local write of a different value to it is pending", async () => {
    render(<SettingsView />);
    await chooseDark();
    let fail: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error("offline"));
    }));
    let systemWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      systemWrite = useSettingsStore.getState().update({ appearance: { theme: "system" } });
    });
    act(() => useSettingsStore.getState()._applyPush(themeOf(useSettingsStore.getState().settings, "light")));
    await act(async () => {
      fail();
      await systemWrite;
    });

    expect(revertButton()).toBeNull();
    expect(mockTransport.updateSettings).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("light");
  });

  async function pushLightWhileLocalLightIsPending(settle: "land" | "fail") {
    render(<SettingsView />);
    await chooseDark();
    let finish: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => new Promise((resolve, reject) => {
      finish = settle === "land" ? () => resolve(mergeSettings(useSettingsStore.getState().settings, patch)) : () => reject(new Error("offline"));
    }));
    let lightWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      lightWrite = useSettingsStore.getState().update({ appearance: { theme: "light" } });
    });
    act(() => useSettingsStore.getState()._applyPush(themeOf(useSettingsStore.getState().settings, "light")));
    await act(async () => {
      finish();
      await lightWrite;
    });
  }

  it("releases a setting claimed for a pending local write once that write fails", async () => {
    await pushLightWhileLocalLightIsPending("fail");

    expect(revertButton()).toBeNull();
    expect(mockTransport.updateSettings).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("light");
  });

  it("keeps the claim of a pending local write that lands", async () => {
    await pushLightWhileLocalLightIsPending("land");

    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
  });

  it("keeps a change made after a pending write's claim when that write later fails", async () => {
    render(<SettingsView />);
    let fail: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error("offline"));
    }));
    let lightWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      lightWrite = useSettingsStore.getState().update({ appearance: { theme: "light" } });
    });
    act(() => useSettingsStore.getState()._applyPush(themeOf(useSettingsStore.getState().settings, "light")));
    await act(async () => {
      await useSettingsStore.getState().update({ appearance: { theme: "system" } });
      await useSettingsStore.getState().update({ appearance: { theme: "dark" } });
    });
    await act(async () => {
      fail();
      await lightWrite;
    });

    expect(useSettingsStore.getState().settings.appearance.theme).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();
    expect(vi.mocked(mockTransport.updateSettings).mock.calls.at(-1)?.[0]).toEqual({ appearance: { theme: "system" } });
  });

  it("claims its own write when the push for it arrives before the write's response", async () => {
    render(<SettingsView />);
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => {
      const pushed = mergeSettings(useSettingsStore.getState().settings, patch);
      useSettingsStore.getState()._applyPush(pushed);
      return Promise.resolve(pushed);
    });
    await chooseDark();

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();

    expect(vi.mocked(mockTransport.updateSettings).mock.calls.at(-1)?.[0]).toEqual({ appearance: { theme: "system" } });
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("system");
  });

  it("does not claim another window's change to one Fast flag while a local write to the other is pending", async () => {
    render(<SettingsView />);
    let land: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce((patch) => {
      const pushed = mergeSettings(useSettingsStore.getState().settings, patch);
      useSettingsStore.getState()._applyPush(pushed);
      return new Promise((resolve) => {
        land = () => resolve(mergeSettings(useSettingsStore.getState().settings, patch));
      });
    });
    let codexWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      codexWrite = useSettingsStore.getState().update({ provider: { codex: { fastMode: true } } });
    });
    act(() => {
      const settings = useSettingsStore.getState().settings;
      useSettingsStore.getState()._applyPush({ ...settings, provider: { ...settings.provider, claude: { ...settings.provider.claude, fastMode: true } } });
    });
    await act(async () => {
      land();
      await codexWrite;
    });

    expect(useSettingsStore.getState().settings.provider.claude.fastMode).toBe(true);
    expect(revertButton()).toBeNull();
    expect(mockTransport.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("releases the Fast row when a pending write to one flag fails after a write to the other lands", async () => {
    render(<SettingsView />);
    let fail: () => void = () => {};
    vi.mocked(mockTransport.updateSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error("offline"));
    }));
    let codexWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      codexWrite = useSettingsStore.getState().update({ provider: { codex: { fastMode: true } } });
    });
    act(() => {
      const settings = useSettingsStore.getState().settings;
      useSettingsStore.getState()._applyPush({ ...settings, provider: { ...settings.provider, codex: { ...settings.provider.codex, fastMode: true } } });
    });
    await act(async () => {
      await useSettingsStore.getState().update({ provider: { claude: { fastMode: true } } });
    });
    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
    await act(async () => {
      fail();
      await codexWrite;
    });

    expect(useSettingsStore.getState().settings.provider.codex.fastMode).toBe(true);
    expect(revertButton()).toBeNull();
  });

  it("releases the terminal default another window set while a local default write is pending", async () => {
    openPage("terminal");
    render(<SettingsView />);
    await flush();
    let fail: () => void = () => {};
    vi.mocked(mockTransport.terminalProfileSetDefault).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      fail = () => reject(new Error("offline"));
    }));
    let defaultWrite: Promise<unknown> = Promise.resolve();
    act(() => {
      defaultWrite = useTerminalSettingsStore.getState().setGlobalDefault("certified:windows-cmd");
    });
    act(() => {
      const settings = useSettingsStore.getState().settings;
      useSettingsStore.getState()._applyPush({ ...settings, terminal: { ...settings.terminal, defaultProfileId: "certified:windows-git-bash" } });
    });
    await act(async () => {
      fail();
      await defaultWrite;
    });

    expect(useSettingsStore.getState().settings.terminal.defaultProfileId).toBe("certified:windows-git-bash");
    expect(revertButton()).toBeNull();
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
  });

  it("keeps Revert offered when the updater could not switch back, and a retry switches it", async () => {
    const applyReleaseLine = vi.fn(() => Promise.resolve({ state: "idle" as const }))
      .mockRejectedValueOnce(new Error("Updater is busy."));
    vi.stubGlobal("desktopBridge", { app: { applyReleaseLine } });
    render(<SettingsView />);
    await act(async () => {
      await useSettingsStore.getState().update({ updates: { channel: "nightly" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();

    expect(useSettingsStore.getState().settings.updates.channel).toBe("stable");
    const button = screen.getByRole("button", { name: "Revert 1 change" });
    expect(await tooltipOf(button)).toBe("Could not put back Release line: Updater is busy. Puts back Release line");

    fireEvent.click(button);
    await flush();

    expect(applyReleaseLine).toHaveBeenCalledTimes(2);
    expect(applyReleaseLine.mock.calls.at(-1)).toEqual([{ releaseLine: "stable", allowDowngrade: false }]);
    expect(revertButton()).toBeNull();
  });

  it("keeps a release line picked again while Revert was switching the updater back", async () => {
    let switched: () => void = () => {};
    const applyReleaseLine = vi.fn(() => new Promise<{ state: "idle" }>((resolve) => {
      switched = () => resolve({ state: "idle" });
    }));
    vi.stubGlobal("desktopBridge", { app: { applyReleaseLine } });
    render(<SettingsView />);
    await act(async () => {
      await useSettingsStore.getState().update({ updates: { channel: "nightly" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Revert 1 change" }));
    await flush();
    expect(applyReleaseLine).toHaveBeenCalledTimes(1);
    await act(async () => {
      await useSettingsStore.getState().update({ updates: { channel: "nightly" } });
    });
    await act(async () => switched());

    expect(useSettingsStore.getState().settings.updates.channel).toBe("nightly");
    expect(screen.getByRole("button", { name: "Revert 1 change" })).toBeInTheDocument();
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
