import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSettings, type SettingsProviderId } from "@mcode/contracts/models/settings";
import { PROVIDER_CATALOG } from "@mcode/contracts/providers/catalog";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSettingsLocation } from "@/stores/settingsLocationStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { SettingsNav } from "../SettingsNav";
import { SettingsView } from "../SettingsView";
import { seedProviderAvailability } from "./settings-fixtures";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/** A settings store whose update applies the patch, so a control's write shows on screen like the real store. */
function seedSettings(provider: SettingsProviderId = "claude") {
  const defaults = getDefaultSettings();
  const update = vi.fn(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: deepMerge(current, patch) as typeof current });
  });
  useSettingsStore.setState({
    settings: { ...defaults, model: { ...defaults.model, defaults: { ...defaults.model.defaults, provider } } },
    loaded: true,
    update,
  });
  return update;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (typeof base !== "object" || base === null || typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value);
  return out;
}

function renderSettings() {
  return render(
    <>
      <SettingsNav />
      <SettingsView />
    </>,
  );
}

function search(text: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: text } });
}

beforeEach(() => {
  useSettingsLocation.getState().openPage("general");
  useSettingsLocation.getState().leave();
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1" });
  seedProviderAvailability();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  // jsdom has no layout, so scrolling is a recorded no-op.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Settings search", () => {
  it("changes a setting from its result and shows the new value on the page", async () => {
    seedSettings();
    renderSettings();
    search("notif");

    expect(await screen.findByRole("heading", { name: 'Best match for "notif"' })).toBeInTheDocument();
    const before = useSettingsStore.getState().settings.notifications.enabled;
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));
    expect(useSettingsStore.getState().settings.notifications.enabled).toBe(!before);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveAttribute("aria-checked", String(!before));
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("names the search in the header and marks no page while results show", async () => {
    seedSettings();
    renderSettings();
    search("theme");
    await screen.findByRole("heading", { name: 'Best match for "theme"' });
    expect(screen.getByText("Search")).toBeInTheDocument();
    for (const link of screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-current"))) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("opens a result on its page, marks and focuses the row, and goes back to the same results", async () => {
    seedSettings();
    renderSettings();
    search("retention");
    const link = await screen.findByRole("button", { name: /^Go to Closed thread retention in Threads/ });
    fireEvent.click(link);

    const row = document.querySelector('[data-setting-id="threads.retention"]');
    expect(row).toHaveAttribute("data-search-hit");
    expect(row).toHaveFocus();
    expect(screen.getByRole("button", { name: "Threads" })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
    expect(screen.getByRole("heading", { name: 'Best match for "retention"' })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("retention");
    expect(screen.getByRole("button", { name: /^Go to Closed thread retention in Threads/ })).toHaveFocus();
  });

  it("clears the mark when typing again and clears the query when a page is chosen", async () => {
    seedSettings();
    renderSettings();
    search("retention");
    fireEvent.click(await screen.findByRole("button", { name: /^Go to Closed thread retention/ }));
    search("retentio");
    expect(document.querySelector("[data-search-hit]")).toBeNull();
    expect(screen.getByRole("heading", { name: 'Best match for "retentio"' })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to results" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: /Best match/ })).not.toBeInTheDocument();
  });

  it("clears a non-empty field on Escape", () => {
    seedSettings();
    renderSettings();
    search("theme");
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search settings" }), { key: "Escape" });
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
  });

  it("says when nothing matches", () => {
    seedSettings();
    renderSettings();
    search("zzzz");
    expect(screen.getByText('No settings match "zzzz".')).toBeInTheDocument();
  });

  it("explains a setting that does not apply and opens the choice that controls it", async () => {
    seedSettings("codex");
    renderSettings();
    search("thinking");
    const result = (await screen.findByRole("button", { name: /^Go to Thinking in Threads/ })).closest("div")?.parentElement as HTMLElement;
    expect(within(result).queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(within(result).getByRole("button", { name: /^Go to Thinking/ }));
    expect(document.querySelector("[data-search-hit]")).toHaveAttribute("data-setting-id", "threads.model");
  });

  it("opens a collapsed provider's details for a CLI path hit and marks the row with the input inside", async () => {
    seedSettings();
    renderSettings();
    search("claude cli path");
    fireEvent.click(await screen.findByRole("button", { name: /^Go to .* in Providers, Claude$/ }));
    const marked = document.querySelector("[data-search-hit]") as HTMLElement;
    expect(marked).toHaveAttribute("data-setting-id", "providers.claude.cliPath");
    expect(within(marked).getByRole("textbox")).toBeVisible();
  });

  it("focuses a provider hit whose row mounts after availability loads", async () => {
    seedSettings();
    useProviderAvailabilityStore.setState({ providers: [] });
    renderSettings();
    act(() => useSettingsLocation.getState().openHit({ page: "providers", id: "providers.claude.enabled", from: "providers.claude.enabled" }));
    expect(document.querySelector("[data-search-hit]")).toBeNull();

    act(() => seedProviderAvailability());
    const marked = document.querySelector("[data-search-hit]");
    expect(marked).not.toBeNull();
    expect(marked).toHaveFocus();
  });

  it("still blocks disabling the last enabled provider from a result", async () => {
    const update = seedSettings();
    seedProviderAvailability(
      Object.fromEntries(PROVIDER_CATALOG.filter((entry) => entry.id !== "claude").map((entry) => [entry.id, { enabled: false }])),
    );
    renderSettings();
    search("claude");
    const toggle = await screen.findByRole("switch", { name: "Claude enabled" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("At least one provider must be enabled.")).toBeInTheDocument();
  });

  it("changes a terminal setting from a result and keeps it on the Terminal page", async () => {
    seedSettings();
    renderSettings();
    search("cursor blink");
    const toggle = await screen.findByRole("switch", { name: /cursor blink/i });
    const before = toggle.getAttribute("aria-checked");
    fireEvent.click(toggle);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(await screen.findByRole("switch", { name: /cursor blink/i })).not.toHaveAttribute("aria-checked", before ?? "");
  });
});
