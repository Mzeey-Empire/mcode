import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getDefaultSettings } from "@mcode/contracts";

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
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ProviderSection } from "../ProviderSection";

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), update: async () => {} });
  useProviderAvailabilityStore.setState({
    providers: [
      { id: "claude",   enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: { status: "found",     resolvedPath: "/a", configuredPath: "" } },
      { id: "codex",    enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: { status: "not_found", resolvedPath: null, configuredPath: "" } },
      { id: "copilot",  enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "gemini",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "cursor",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "opencode", enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
    ],
  });
});

describe("ProviderSection", () => {
  it("renders one switch per provider", () => {
    render(<ProviderSection />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(6);
  });

  it("renders the Beta badge for copilot and Coming soon for gemini/cursor/opencode", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-copilot-beta")).toBeInTheDocument();
    expect(screen.getByTestId("provider-badge-gemini-comingsoon")).toBeInTheDocument();
  });

  it("renders a CLI-not-found badge when enabled and status='not_found'", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-badge-codex-cli-missing")).toBeInTheDocument();
  });

  it("disables the switch for coming-soon providers", () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-switch-gemini")).toBeDisabled();
  });

  it("shows CLI path input only for enabled providers with an adapter", async () => {
    render(<ProviderSection />);
    expect(screen.getByTestId("provider-cli-path-claude")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-cli-path-copilot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-cli-path-gemini")).not.toBeInTheDocument();
  });
});
