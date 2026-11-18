import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { SETTINGS_PAGES } from "../settings-nav";
import type { SettingDef } from "../setting-def";
import { seedProviderAvailability } from "./settings-fixtures";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true, update: vi.fn(async () => {}) });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1" });
  seedProviderAvailability();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});

/** Ids the page should draw: every setting that exists here and applies to the current choices. */
function ApplicableIds({ settings, onIds }: { settings: readonly SettingDef[]; onIds: (ids: string[]) => void }) {
  // The list is fixed for the page, so each condition hook runs in the same order on every render.
  const applies = settings.map((def) => def.when?.useApplies() ?? true);
  onIds(settings.filter((def, index) => applies[index] && (def.exists?.() ?? true)).map((def) => def.id));
  return null;
}

describe("settings pages and their definitions", () => {
  it.each(SETTINGS_PAGES.map((page) => [page.id, page] as const))("%s draws exactly the settings it registers", async (_id, page) => {
    let expected: string[] = [];
    const Page = page.component;
    const { container } = render(
      <>
        <ApplicableIds settings={page.settings} onIds={(ids) => { expected = ids; }} />
        <Page />
      </>,
    );
    await act(async () => {});
    // Provider details start closed; open them so their rows count.
    for (const trigger of screen.queryAllByRole("button", { name: / settings$/, expanded: false })) fireEvent.click(trigger);

    // A control that stands for several settings, such as the Threads model part, lists the others in data-setting-covers.
    const drawn = [
      ...[...container.querySelectorAll("[data-setting-id]")].map((element) => element.getAttribute("data-setting-id")),
      ...[...container.querySelectorAll("[data-setting-covers]")].flatMap((element) => (element.getAttribute("data-setting-covers") ?? "").split(" ").filter(Boolean)),
    ];
    expect(new Set(drawn).size).toBe(drawn.length);
    expect([...drawn].sort()).toEqual([...expected].sort());
  });
});
