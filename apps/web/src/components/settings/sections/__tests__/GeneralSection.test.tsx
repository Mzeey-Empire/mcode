import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { OpenInApp } from "@/transport/types";

// vi.hoisted so the refs exist inside the vi.mock factories below.
const { mockSettingsSelector, mockApps } = vi.hoisted(() => ({
  mockSettingsSelector: vi.fn(),
  mockApps: { value: [] as OpenInApp[] },
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: vi.fn((selector: (s: unknown) => unknown) => mockSettingsSelector(selector)),
}));

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => mockApps.value,
}));

import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { GeneralSection, buildOpenInAppOptions } from "../GeneralSection";

/** Minimal OpenInApp factory for option-building assertions. */
function app(partial: Partial<OpenInApp> & Pick<OpenInApp, "id">): OpenInApp {
  return {
    label: partial.id,
    kind: "editor",
    iconKey: partial.id,
    detected: true,
    ...partial,
  };
}

const CODE = app({ id: "code", label: "VS Code", iconKey: "vscode" });
const CURSOR = app({ id: "cursor", label: "Cursor", iconKey: "cursor" });
const ZED_UNDETECTED = app({ id: "zed", label: "Zed", iconKey: "zed", detected: false });

describe("buildOpenInAppOptions", () => {
  it("always offers Auto first with an empty value", () => {
    const opts = buildOpenInAppOptions([CODE], "");
    expect(opts[0]).toMatchObject({ value: "", label: "Auto" });
  });

  it("lists only detected apps after Auto", () => {
    const opts = buildOpenInAppOptions([CODE, CURSOR, ZED_UNDETECTED], "");
    expect(opts.map((o) => o.value)).toEqual(["", "code", "cursor"]);
  });

  it("keeps a saved-but-uninstalled id selectable as not installed", () => {
    const opts = buildOpenInAppOptions([CODE], "zed");
    const stale = opts.find((o) => o.value === "zed");
    expect(stale).toBeDefined();
    expect(stale?.label).toContain("not installed");
  });

  it("does not duplicate a saved id that is installed", () => {
    const opts = buildOpenInAppOptions([CODE], "code");
    expect(opts.filter((o) => o.value === "code")).toHaveLength(1);
  });
});

/** Configures the settings store mock to return the given defaultEditor + update spy. */
function renderSection(defaultEditor: string) {
  const update = vi.fn();
  const defaults = getDefaultSettings();
  const state = { settings: { ...defaults, externalApps: { ...defaults.externalApps, defaultEditor } }, update };
  mockSettingsSelector.mockImplementation((selector: (s: unknown) => unknown) => selector(state));
  render(<GeneralSection />);
  return { update };
}

describe("GeneralSection", () => {
  it("renders theme, notifications and the default open-in app", () => {
    mockApps.value = [CODE];
    renderSection("");
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Default open-in app")).toBeInTheDocument();
  });

  it("shows Auto and the app it resolves to when no global default is set", () => {
    mockApps.value = [ZED_UNDETECTED, CURSOR, CODE];
    renderSection("");
    expect(
      screen.getByTestId("settings-default-open-in-trigger"),
    ).toHaveTextContent("Auto · Cursor");
  });

  it("names no app after Auto before the app list loads", () => {
    mockApps.value = [];
    renderSection("");
    expect(
      screen.getByTestId("settings-default-open-in-trigger"),
    ).toHaveTextContent(/^Auto$/);
  });

  it("picks the theme from its window previews", () => {
    mockApps.value = [CODE];
    const { update } = renderSection("");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(update).toHaveBeenCalledWith({ appearance: { theme: "light" } });
  });

  it("shows the selected app label on the trigger when a default is set", () => {
    mockApps.value = [CODE];
    renderSection("code");
    expect(
      screen.getByTestId("settings-default-open-in-trigger"),
    ).toHaveTextContent("VS Code");
  });
});
