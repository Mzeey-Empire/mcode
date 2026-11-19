import { mockTransport } from "@/__tests__/mocks/transport";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import type { TerminalProfileReference } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate } from "@mcode/contracts/models/terminal-settings";


vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.terminalProfileList).mockReset().mockResolvedValue({ certified: [], custom: [] });
  vi.mocked(mockTransport.terminalWorkspacePreferencesGet).mockReset();
});

import { TerminalSection } from "../TerminalSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalSettingsStore } from "../terminalSettingsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const PWSH_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function detected(slug: string, name: string) {
  return {
    id: `certified:${slug}` as const,
    name,
    executable: slug === "pwsh" ? PWSH_PATH : `C:\\Windows\\System32\\${slug}.exe`,
    arguments: [],
    source: "certified" as const,
    platform: "windows" as const,
  };
}

function setDefaultProfile(id: TerminalProfileReference) {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({ settings: { ...settings, terminal: { ...settings.terminal, defaultProfileId: id } } });
}

function applyPreferenceWrites() {
  useTerminalSettingsStore.setState({
    updatePreferences: vi.fn(async (input: TerminalPreferencesUpdate) => {
      const terminal = useSettingsStore.getState().settings.terminal;
      useSettingsStore.getState()._applyTerminalPreferences({
        ...terminal,
        presentation: { ...terminal.presentation, ...input.presentation },
      });
      return true;
    }),
  });
}

async function openFontPicker() {
  fireEvent.click(screen.getByRole("button", { name: /^Terminal font family/ }));
  return screen.findByRole("combobox", { name: "Search fonts" });
}

function profileRowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("region", { name: "Available profiles" })).getByText(name).parentElement;
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

describe("TerminalSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    useTerminalSettingsStore.setState({
      certifiedProfiles: [],
      customProfiles: [],
      recovery: null,
      profilesLoaded: true,
      profilesLoading: false,
      workspaceOverride: null,
      workspaceLoading: false,
      pending: false,
      error: null,
      deleteReferences: null,
      fetchProfiles: vi.fn(),
      fetchWorkspaceOverride: vi.fn(),
      setGlobalDefault: vi.fn().mockResolvedValue(true),
      setWorkspaceDefault: vi.fn().mockResolvedValue(true),
      resetWorkspaceDefault: vi.fn().mockResolvedValue(true),
      createProfile: vi.fn().mockResolvedValue(true),
      updateProfile: vi.fn().mockResolvedValue(true),
      deleteProfile: vi.fn().mockResolvedValue(true),
      updatePreferences: vi.fn().mockResolvedValue(true),
      resetPreferences: vi.fn().mockResolvedValue(true),
      clearError: vi.fn(),
    });
  });

  it("shows complete sections and bounded, named Terminal controls", { timeout: 15_000 }, () => {
    render(<TerminalSection />);

    expect(screen.getByRole("heading", { name: "Profiles" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Available profiles" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Font and cursor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Behavior" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Accessibility" })).toBeInTheDocument();
    expect(screen.getByLabelText("Scrollback lines")).toHaveAttribute("min", "100");
    expect(screen.getByLabelText("Scrollback lines")).toHaveAttribute("max", "5000");
    expect(screen.getByLabelText("Session limit")).toHaveAttribute("min", "1");
    expect(screen.getByLabelText("Session limit")).toHaveAttribute("max", "20");
    expect(screen.getByRole("button", { name: "Reset Terminal preferences" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default Terminal profile" })).toHaveTextContent("Automatic");
  });

  it("keeps inherited and explicit Automatic workspace profiles distinct", { timeout: 15_000 }, async () => {
    const workspaceId = "workspace-1";
    const user = userEvent.setup();
    useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
    render(<TerminalSection />);

    const trigger = screen.getByRole("button", { name: "Workspace Terminal profile" });
    expect(trigger).toHaveTextContent("Use inherited global profile");
    await user.click(trigger);
    await screen.findByRole("option", { name: "Use inherited global profile" });
    await user.click(await screen.findByRole("option", { name: "Automatic" }));
    const setWorkspaceDefault = useTerminalSettingsStore.getState().setWorkspaceDefault as ReturnType<typeof vi.fn>;
    expect(setWorkspaceDefault).toHaveBeenCalledWith(workspaceId, "automatic");
  });

  it("writes a picked font in the stored format and the sample draws in it", async () => {
    applyPreferenceWrites();
    render(<TerminalSection />);

    await openFontPicker();
    fireEvent.click(await screen.findByRole("option", { name: "Consolas" }));

    const stored = useSettingsStore.getState().settings.terminal.presentation.fontFamily;
    expect(stored).toBe('"Consolas", "JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Cascadia Code", monospace');
    expect(screen.getByRole("img", { name: "Terminal preview" }).style.fontFamily).toBe(stored);
    expect(screen.getByRole("button", { name: "Terminal font family: Consolas" })).toBeInTheDocument();
  });

  it("lists the current font as selected even when the common list lacks it", async () => {
    render(<TerminalSection />);

    await openFontPicker();

    expect(await screen.findByRole("option", { name: "JetBrains Mono Variable" })).toHaveAttribute("aria-selected", "true");
  });

  it("offers a typed name with no match and writes it", async () => {
    applyPreferenceWrites();
    render(<TerminalSection />);

    const search = await openFontPicker();
    fireEvent.change(search, { target: { value: "My  Odd Font" } });
    fireEvent.click(await screen.findByRole("option", { name: 'Use "My Odd Font"' }));

    expect(useSettingsStore.getState().settings.terminal.presentation.fontFamily).toMatch(/^"My Odd Font", .*monospace$/);
  });

  it("changes font size in the sample and the store while the sample keeps its height", async () => {
    applyPreferenceWrites();
    render(<TerminalSection />);
    const sample = screen.getByRole("img", { name: "Terminal preview" });
    const heightBefore = sample.style.height;

    fireEvent.click(screen.getByRole("radio", { name: "17" }));

    expect(useSettingsStore.getState().settings.terminal.presentation.fontSize).toBe("lg");
    expect(sample.style.fontSize).toBe("17px");
    expect(sample.style.height).toBe(heightBefore);
    expect(heightBefore).not.toBe("");
  });

  it("tags the profile a new terminal opens with", () => {
    useTerminalSettingsStore.setState({ certifiedProfiles: [detected("pwsh", "PowerShell"), detected("cmd", "Command Prompt")] });
    const { rerender } = render(<TerminalSection />);
    expect(profileRowOf("PowerShell")).toHaveTextContent("In use");
    expect(profileRowOf("Command Prompt")).not.toHaveTextContent("In use");

    setDefaultProfile("certified:cmd");
    rerender(<TerminalSection />);
    expect(profileRowOf("PowerShell")).not.toHaveTextContent("In use");
    expect(profileRowOf("Command Prompt")).toHaveTextContent("In use");
  });

  it("shows a profile's file name and names its full path", () => {
    useTerminalSettingsStore.setState({ certifiedProfiles: [detected("pwsh", "PowerShell")] });
    render(<TerminalSection />);

    const path = screen.getByLabelText(PWSH_PATH);
    expect(path).toHaveTextContent(/^pwsh\.exe/);
  });

  it("shows blocked profiles and the unavailable selected reference for repair", () => {
    const blockedProfile = {
      id: "custom:11111111-1111-4111-8111-111111111111" as const,
      name: "Recovered shell",
      executable: "sh",
      arguments: [],
    };
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        terminal: { ...getDefaultSettings().terminal, defaultProfileId: "automatic" },
      },
    });
    useTerminalSettingsStore.setState({
      recovery: {
        status: "blocked",
        reason: "missing-profile-reference",
        blockedProfiles: [blockedProfile],
        unavailableProfileId: "custom:22222222-2222-4222-8222-222222222222",
      },
    });

    render(<TerminalSection />);

    expect(screen.getByText(/Terminal settings need repair/)).toBeInTheDocument();
    expect(screen.getByText("Recovered shell")).toBeInTheDocument();
    expect(screen.getByText(/Selected profile is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Default Terminal profile" })).toHaveTextContent("Unavailable: Custom profile");
  });

  it("shows the selected custom profile name in the trigger", () => {
    const customProfile = {
      id: "custom:11111111-1111-4111-8111-111111111111" as const,
      name: "Live Test Profile",
      executable: "sh",
      arguments: [],
    };
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        terminal: { ...getDefaultSettings().terminal, defaultProfileId: customProfile.id },
      },
    });
    useTerminalSettingsStore.setState({ customProfiles: [customProfile] });

    render(<TerminalSection />);

    expect(screen.getByRole("button", { name: "Default Terminal profile" })).toHaveTextContent("Live Test Profile");
  });
});
