import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingsNav } from "../SettingsNav";
import { SettingsView } from "../SettingsView";
import type { SettingsSection } from "../settings-nav";
import { mockTransport } from "@/__tests__/mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function SettingsHarness() {
  const [section, setSection] = useState<SettingsSection>("general");
  return (
    <>
      <nav aria-label="Settings pages">
        <SettingsNav section={section} onSection={setSection} />
      </nav>
      <main>
        <SettingsView section={section} />
      </main>
    </>
  );
}

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), update: vi.fn(async () => {}) });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsNav", () => {
  it("lists exactly the seven pages in order", () => {
    render(<SettingsHarness />);
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "General",
      "Threads",
      "Providers",
      "Terminal",
      "Keyboard shortcuts",
      "Troubleshooting",
      "About",
    ]);
  });

  it("renders the chosen page", () => {
    render(<SettingsHarness />);
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "General" })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: "Troubleshooting" }));
    expect(within(main).getByRole("heading", { name: "Troubleshooting" })).toBeInTheDocument();
    expect(within(main).queryByRole("heading", { name: "General" })).toBeNull();

    fireEvent.click(within(nav).getByRole("button", { name: "About" }));
    expect(within(main).getByRole("heading", { name: "About" })).toBeInTheDocument();
  });
});
