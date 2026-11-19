import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { ProvidersSection } from "../ProvidersSection";

const update = vi.fn(async () => {});

beforeEach(() => {
  update.mockClear();
  useSettingsStore.setState({ settings: getDefaultSettings(), update });
  useProviderAvailabilityStore.setState({
    providers: [
      { id: "claude", enabled: true, hasAdapter: true, beta: false, comingSoon: false, capabilities: [], cli: { status: "found", resolvedPath: "/a", configuredPath: "" } },
    ],
  });
});

describe("ProvidersSection", () => {
  it("shows the provider list and the CLI update check switch", () => {
    render(<ProvidersSection />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Asks the npm registry once a day for newer provider CLIs.")).toBeInTheDocument();
  });

  it("defaults the CLI update check on and saves it when switched off", () => {
    render(<ProvidersSection />);
    const toggle = screen.getByRole("switch", { name: "Check for CLI updates" });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ updates: { providerCliChecks: false } });
  });

  it("reads a saved off setting and saves it back on", () => {
    const defaults = getDefaultSettings();
    useSettingsStore.setState({ settings: { ...defaults, updates: { ...defaults.updates, providerCliChecks: false } } });
    render(<ProvidersSection />);
    const toggle = screen.getByRole("switch", { name: "Check for CLI updates" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ updates: { providerCliChecks: true } });
  });
});
