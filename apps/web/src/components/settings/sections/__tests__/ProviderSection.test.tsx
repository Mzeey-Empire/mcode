import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getDefaultSettings } from "@mcode/contracts/models/settings";

// @base-ui/react (used by Switch) does not work in jsdom; stub it with a native button.
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "data-testid": testId,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
}));

// @base-ui/react (used by Badge) does not work in jsdom; stub as a plain span.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    "data-testid": testId,
    ...rest
  }: {
    children?: React.ReactNode;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <span data-testid={testId} {...rest}>
      {children}
    </span>
  ),
}));

// @base-ui/react (used by Tooltip) does not work in jsdom; stub it out.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode | (() => React.ReactNode) }) => <>{typeof children === "function" ? null : children}</>,
  TooltipTrigger: ({ children, render }: { children?: React.ReactNode; render?: React.ReactNode }) => <>{render ?? children}</>,
  createTooltipHandle: () => ({}),
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ProviderSection } from "../ProviderSection";

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), update: async () => {} });
  useProviderAvailabilityStore.setState({
    providers: [
      { id: "claude",   enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, capabilities: [], cli: { status: "found",     resolvedPath: "/a", configuredPath: "" } },
      { id: "codex",    enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, capabilities: [], cli: { status: "not_found", resolvedPath: null, configuredPath: "" } },
      { id: "copilot",  enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "gemini",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "cursor",   enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "opencode", enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "devin",    enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, capabilities: [], cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
    ],
  });
});

describe("ProviderSection", () => {
  it("shows the last-enabled constraint first and still shows a Claude version warning", () => {
    const warning = "Update Claude Code to a supported version.";
    useProviderAvailabilityStore.setState(({ providers }) => ({
      providers: providers.map((row) => ({
        ...row,
        enabled: row.id === "claude",
        cli: { ...row.cli, ...(row.id === "claude" ? { warning } : {}) },
      })),
    }));
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-switch-claude")).toBeDisabled();
    expect(screen.getByText(`At least one provider must be enabled. ${warning}`)).toBeInTheDocument();
  });

  // Fails if the last-enabled guard is dropped and the switch lets Claude turn off.
  it("blocks disabling the last enabled provider", async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: getDefaultSettings(), update });
    useProviderAvailabilityStore.setState(({ providers }) => ({ providers: providers.map((row) => ({ ...row, enabled: row.id === "claude" })) }));
    render(<ProviderSection />);
    const toggle = screen.getByRole("switch", { name: "Claude enabled" });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(update).not.toHaveBeenCalled();
  });

  // Fails if the missing CLI moves into a hover-only tooltip.
  it.each(["Claude Code is not installed.", "Point the CLI path at claude.exe or the claude binary."])("shows a missing CLI and its guidance without hover: %s", (message) => {
    useProviderAvailabilityStore.setState(({ providers }) => ({ providers: providers.map((row) => row.id === "claude"
      ? { ...row, cli: { ...row.cli, status: "not_found", message } }
      : row) }));
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-claude-cli-missing")).toHaveTextContent("CLI not found");
    expect(screen.getByText(message)).toBeVisible();
  });

  it("shows a version warning as a hint without a missing CLI state", () => {
    const warning = "Update Claude Code to a supported version.";
    useProviderAvailabilityStore.setState(({ providers }) => ({ providers: providers.map((row) => row.id === "claude"
      ? { ...row, cli: { ...row.cli, warning } }
      : row) }));
    render(<ProviderSection />);
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.queryByTestId("provider-badge-claude-cli-missing")).not.toBeInTheDocument();
  });

  // Fails if the path line drops the file name or loses the full path for hover and screen readers.
  it("shows the CLI file name first and keeps the full path as its accessible name", () => {
    useProviderAvailabilityStore.setState(({ providers }) => ({ providers: providers.map((row) => row.id === "claude"
      ? { ...row, cli: { ...row.cli, resolvedPath: "C:\\Users\\me\\bin\\claude.exe" } }
      : row) }));
    render(<ProviderSection />);
    const path = screen.getByLabelText("C:\\Users\\me\\bin\\claude.exe");
    expect(path.firstElementChild).toHaveTextContent(/^claude\.exe$/);
    expect(path).toHaveTextContent("C:\\Users\\me\\bin");
  });

  it("renders switches only for available providers", () => {
    render(<ProviderSection />);
    const switches = screen.getAllByRole("switch");
    expect(switches.map((element) => element.dataset.testid)).toEqual([
      "provider-switch-claude",
      "provider-switch-codex",
      "provider-switch-copilot",
      "provider-switch-cursor",
      "provider-switch-opencode",
      "provider-switch-devin",
    ]);
    expect(screen.queryByTestId("provider-switch-gemini")).not.toBeInTheDocument();
  });

  it("renders Beta badges for beta providers and a Coming soon badge for planned providers", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-copilot-beta")).toBeInTheDocument();
    expect(screen.getByTestId("provider-badge-opencode-beta")).toBeInTheDocument();
    expect(screen.getByTestId("provider-badge-gemini-comingsoon")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-badge-opencode-comingsoon")).not.toBeInTheDocument();
  });

  it("shows a coming-soon provider as a disabled row with no switch or details", () => {
    render(<ProviderSection />);
    const row = screen.getByTestId("provider-row-gemini-comingsoon");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("Gemini")).toBeInTheDocument();
    expect(within(row).queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gemini settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("Adapter not available yet.")).not.toBeInTheDocument();
  });

  it("renders a CLI-not-found state when enabled and status='not_found'", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-codex-cli-missing")).toBeInTheDocument();
  });

  it("starts with every provider's details closed", () => {
    render(<ProviderSection />);
    expect(screen.queryByTestId("provider-cli-path-claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-cli-path-copilot")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude settings" })).toHaveAttribute("aria-expanded", "false");
  });

  // Fails if the row stops opening its details, or if the switch's click bubbles up and opens them.
  it("opens a provider's details from its row but not from its switch", async () => {
    const user = userEvent.setup();
    render(<ProviderSection />);

    await user.click(screen.getByRole("switch", { name: "Codex enabled" }));
    expect(screen.queryByTestId("provider-cli-path-codex")).not.toBeInTheDocument();

    await user.click(screen.getByText("Claude"));
    expect(screen.getByTestId("provider-cli-path-claude")).toBeVisible();
    const trigger = screen.getByRole("button", { name: "Claude settings" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(trigger.getAttribute("aria-controls") ?? "")).toContainElement(screen.getByTestId("provider-cli-path-claude"));

    await user.click(trigger);
    expect(screen.queryByTestId("provider-cli-path-claude")).not.toBeInTheDocument();
  });

  it("updates a disabled Beta provider's CLI path", async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: getDefaultSettings(), update });
    render(<ProviderSection />);
    await user.click(screen.getByRole("button", { name: "GitHub Copilot settings" }));

    fireEvent.change(screen.getByTestId("provider-cli-path-copilot"), {
      target: { value: "/custom/copilot" },
    });

    expect(update).toHaveBeenCalledWith({
      provider: { cli: { copilot: "/custom/copilot" } },
    });
  });

  it("commits a normalized OpenCode server URL on blur", async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: getDefaultSettings(), update });
    render(<ProviderSection />);
    await user.click(screen.getByRole("button", { name: "OpenCode settings" }));

    const input = screen.getByTestId("provider-serve-url-opencode");
    await user.type(input, "http://127.0.0.1:4096/");
    expect(update).not.toHaveBeenCalled();
    await user.tab();

    expect(update).toHaveBeenCalledWith({ provider: { opencode: { serveUrl: "http://127.0.0.1:4096" } } });
    expect(input).toHaveValue("http://127.0.0.1:4096");
  });

  it("rejects a non-http OpenCode server URL without saving it", async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: getDefaultSettings(), update });
    render(<ProviderSection />);
    await user.click(screen.getByRole("button", { name: "OpenCode settings" }));

    const input = screen.getByTestId("provider-serve-url-opencode");
    await user.type(input, "file:///tmp/serve{Enter}");

    expect(update).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter an http or https URL, or leave it empty.")).toBeInTheDocument();
  });

  it("shows the OpenCode CLI path alongside its server URL", async () => {
    const user = userEvent.setup();
    render(<ProviderSection />);
    await user.click(screen.getByRole("button", { name: "OpenCode settings" }));
    expect(screen.getByTestId("provider-cli-path-opencode")).toBeEnabled();
    expect(screen.getByTestId("provider-serve-url-opencode")).toHaveAttribute("placeholder", "http://127.0.0.1:4096");
  });
});
