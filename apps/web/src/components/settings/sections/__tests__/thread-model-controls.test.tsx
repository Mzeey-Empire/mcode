import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted ensures these refs are available inside the vi.mock factory below.
const { mockPmState } = vi.hoisted(() => ({
  mockPmState: {
    models: {} as Record<string, import("@/lib/model-registry").ModelDefinition[]>,
    loading: {} as Record<string, boolean>,
    modes: {} as Record<string, readonly string[] | undefined>,
    fetchModels: vi.fn(),
    initialize: vi.fn(),
  },
}));

vi.mock("@/stores/providerModelsStore", () => ({
  useProviderModelsStore: (fn: (s: typeof mockPmState) => unknown) => fn(mockPmState),
}));

vi.mock("@/stores/providerAvailabilityStore", () => ({
  useProviderAvailabilityStore: (fn: (s: { providers: unknown[] }) => unknown) =>
    fn({ providers: [] }),
}));

vi.mock("@/stores/toastStore", () => ({
  useToastStore: Object.assign(vi.fn(), {
    getState: () => ({ show: vi.fn(), dismiss: vi.fn(), toasts: [] }),
  }),
}));

// @base-ui/react (used by Tooltip) does not work in jsdom; stub it out.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { getDefaultSettings, type ReasoningLevel, type SettingsProviderId } from "@mcode/contracts/models/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { Setting } from "../../Setting";
import { THREADS, ThreadsSection } from "../ThreadsSection";

/** Every Threads setting drawn as its own row, as search results draw them; the page folds the model ones into a capsule. */
function ThreadSettingRows() {
  return <>{THREADS.all.map((def) => <Setting key={def.id} def={def} />)}</>;
}

/**
 * Renders the Threads page with the given default provider and model.
 * Returns the update spy for asserting what a control writes.
 */
function renderWithModel(provider: string, modelId: string, reasoning = "high") {
  const defaults = getDefaultSettings();
  const update = vi.fn(async () => {});
  useSettingsStore.setState({
    settings: {
      ...defaults,
      model: {
        ...defaults.model,
        defaults: { ...defaults.model.defaults, provider: provider as SettingsProviderId, id: modelId, reasoning: reasoning as ReasoningLevel },
      },
    },
    update,
  });
  return { state: { update }, ...render(<ThreadSettingRows />) };
}

/** The Reasoning effort row; the page has several segmented controls, so queries stay inside it. */
function getReasoningRow(): HTMLElement {
  return screen.getByText("Reasoning effort").closest("[data-setting-id]") as HTMLElement;
}

describe("Threads page model controls", () => {
  it("keeps the primary model controls without a fallback model setting", () => {
    renderWithModel("claude", "claude-opus-4-7");
    expect(screen.getByText("Provider and model")).toBeInTheDocument();
    expect(screen.queryByText("Fallback model")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups model controls into new-thread defaults and the model for small tasks", () => {
    renderWithModel("claude", "claude-opus-4-7");
    render(<ThreadsSection />);

    for (const name of [
      "New threads start with",
      "Model for small tasks",
    ]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("renders reasoning options in order: Low, Medium, High, X-High, Max for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    const row = getReasoningRow();
    const radios = within(row).getAllByRole("radio");
    const labels = radios.map((r) => r.textContent?.trim());

    expect(labels).toEqual(["Low", "Medium", "High", "X-High", "Max"]);
  });

  it("X-High is enabled for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    const row = getReasoningRow();
    const xhigh = within(row).getByRole("radio", { name: "X-High" });

    expect(xhigh).not.toBeDisabled();
  });

  it("X-High is not offered for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    const row = getReasoningRow();

    expect(within(row).queryByRole("radio", { name: "X-High" })).toBeNull();
  });

  it("Max is enabled for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    const row = getReasoningRow();
    const max = within(row).getByRole("radio", { name: "Max" });

    expect(max).not.toBeDisabled();
  });

  it("Max is enabled for Claude Opus 4.6", () => {
    renderWithModel("claude", "claude-opus-4-6");

    const row = getReasoningRow();
    const max = within(row).getByRole("radio", { name: "Max" });

    expect(max).not.toBeDisabled();
  });

  it("Reasoning Effort row is hidden for Claude Haiku 4.5", () => {
    renderWithModel("claude", "claude-haiku-4-5");

    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("Reasoning Effort row is hidden for Cursor (no backend effort parameter)", () => {
    renderWithModel("cursor", "composer-fast");

    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("Reasoning Effort row is hidden for Copilot (no backend effort parameter)", () => {
    renderWithModel("copilot", "gpt-5");

    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("Reasoning Effort row is visible for Claude Opus 4.7", () => {
    renderWithModel("claude", "claude-opus-4-7");

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
  });

  it("Reasoning Effort row is visible for Claude Sonnet 4.6", () => {
    renderWithModel("claude", "claude-sonnet-4-6");

    expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
  });

  it("renders the Devin family's declared levels for SWE-2", () => {
    renderWithModel("devin", "swe-2");

    const row = getReasoningRow();
    const labels = within(row)
      .getAllByRole("radio")
      .map((r) => r.textContent?.trim());

    expect(labels).toEqual(["Medium", "High", "Max"]);
  });

  it("hides Reasoning effort for a Devin model without declared levels", () => {
    renderWithModel("devin", "unlisted-devin-model");

    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("persists the selected reasoning level", () => {
    const { state } = renderWithModel("claude", "claude-opus-4-7");

    fireEvent.click(within(getReasoningRow()).getByRole("radio", { name: "Low" }));

    expect(state.update).toHaveBeenCalledWith({
      model: { defaults: { reasoning: "low" } },
    });
  });

  it("offers Fast mode for Claude and saves it to Claude's setting", () => {
    const { state } = renderWithModel("claude", "claude-opus-4-7");

    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));

    expect(state.update).toHaveBeenCalledWith({ provider: { claude: { fastMode: true } } });
  });

});
