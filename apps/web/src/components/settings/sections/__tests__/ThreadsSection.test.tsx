import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { getDefaultSettings, type Settings } from "@mcode/contracts/models/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { registerProviderModels } from "@/lib/model-registry";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ProviderModelInfo } from "@/transport/types";
import { seedProviderAvailability } from "../../__tests__/settings-fixtures";
import { ThreadsSection } from "../ThreadsSection";

// The real transport module imports the models store, so spreading it would load the store bound to the real transport.
vi.mock("@/transport", async () => ({
  ...(await vi.importActual<typeof import("@/transport/types")>("@/transport/types")),
  getTransport: () => mockTransport,
}));

const CODEX_MODELS: ProviderModelInfo[] = [
  { id: "gpt-9-deep", name: "GPT-9 Deep", supportedReasoningEfforts: ["low", "medium", "high"] },
  { id: "gpt-9-wide", name: "GPT-9 Wide", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
];

function deepMerge(base: unknown, patch: unknown): unknown {
  if (typeof base !== "object" || base === null || typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value);
  return out;
}

/** A store whose update applies the patch, so a write shows on the page as with the real store. */
function seedSettings(change: (settings: Settings) => Settings = (settings) => settings) {
  const update = vi.fn(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: deepMerge(current, patch) as Settings });
    return undefined as string | undefined;
  });
  useSettingsStore.setState({ settings: change(getDefaultSettings()), loaded: true, update });
  return update;
}

function saved(): Settings {
  return useSettingsStore.getState().settings;
}

async function openModelPicker(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
  return screen.findByRole("dialog", { name: "Choose model and provider" });
}

beforeEach(() => {
  // jsdom lays nothing out; the picker's list renders only the rows that fit its measured height.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 240));
  seedProviderAvailability();
  registerProviderModels("codex", CODEX_MODELS.map((model) => ({
    id: model.id,
    label: model.name,
    providerId: "codex",
    supportedReasoningLevels: model.supportedReasoningEfforts,
  })));
  vi.mocked(mockTransport.listProviderModels).mockResolvedValue(CODEX_MODELS);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});

describe("ThreadsSection new-thread defaults", () => {
  it("writes the provider and model together when a model comes from another provider, keeping a level it offers", async () => {
    const update = seedSettings((s) => ({ ...s, model: { ...s.model, defaults: { ...s.model.defaults, provider: "claude", reasoning: "high" } } }));
    render(<ThreadsSection />);
    const picker = await openModelPicker();
    fireEvent.click(within(picker).getByRole("radio", { name: "Codex" }));
    fireEvent.click(await within(picker).findByRole("option", { name: "GPT-9 Wide" }));
    await act(async () => {});

    expect(update).toHaveBeenCalledTimes(1);
    expect(saved().model.defaults).toMatchObject({ provider: "codex", id: "gpt-9-wide", reasoning: "high" });
  });

  it("writes a level picked in the reasoning pane and names it on the model part", async () => {
    seedSettings((s) => ({ ...s, model: { ...s.model, defaults: { ...s.model.defaults, provider: "codex", id: "gpt-9-deep", reasoning: "high" } } }));
    render(<ThreadsSection />);
    const picker = await openModelPicker();
    const pane = await within(picker).findByRole("listbox", { name: "Reasoning for GPT-9 Deep" });
    fireEvent.click(within(pane).getByRole("option", { name: "Low" }));
    await act(async () => {});

    expect(saved().model.defaults.reasoning).toBe("low");
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveAccessibleName("Model: Codex GPT-9 Deep, Low");
  });

  it.each([["Plan", "plan"], ["Build", "build"]] as const)("writes %s as the default mode", (label, mode) => {
    seedSettings((s) => ({ ...s, agent: { ...s.agent, defaults: { ...s.agent.defaults, mode: mode === "plan" ? "build" : "plan" } } }));
    render(<ThreadsSection />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Mode" })).getByRole("radio", { name: label }));
    expect(saved().agent.defaults.mode).toBe(mode);
  });

  it("writes the permission, and marks the unsupervised choice with the warning icon", async () => {
    seedSettings((s) => ({ ...s, agent: { ...s.agent, defaults: { ...s.agent.defaults, permission: "supervised" } } }));
    render(<ThreadsSection />);
    expect(screen.queryByTestId("settings-unsupervised-icon")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Permission: Ask me" }));
    fireEvent.click(await screen.findByRole("option", { name: /Don't ask/ }));
    await act(async () => {});

    expect(saved().agent.defaults.permission).toBe("full");
    expect(screen.getByRole("button", { name: "Permission: Don't ask" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-unsupervised-icon")).toBeInTheDocument();
  });
});

describe("ThreadsSection small-task model", () => {
  it("saves Auto as the automatic choice and a model as its provider and id", async () => {
    seedSettings((s) => ({ ...s, model: { ...s.model, utility: { provider: "claude", id: "claude-haiku-4-5" } } }));
    render(<ThreadsSection />);

    fireEvent.click(screen.getByRole("button", { name: /^Model for small tasks:/ }));
    let picker = await screen.findByRole("dialog", { name: "Choose the model for small tasks" });
    fireEvent.click(within(picker).getByRole("option", { name: "Auto" }));
    await act(async () => {});
    expect(saved().model.utility).toEqual({ provider: "", id: "" });

    fireEvent.click(screen.getByRole("button", { name: "Model for small tasks: Auto" }));
    picker = await screen.findByRole("dialog", { name: "Choose the model for small tasks" });
    fireEvent.click(within(picker).getByRole("radio", { name: "Codex" }));
    fireEvent.click(await within(picker).findByRole("option", { name: "GPT-9 Deep" }));
    await act(async () => {});
    expect(saved().model.utility).toEqual({ provider: "codex", id: "gpt-9-deep" });
  });
});

describe("ThreadsSection cleanup", () => {
  it("keeps a saved retention period outside the presets selected through opening and closing the picker", async () => {
    seedSettings((s) => ({ ...s, thread: { ...s.thread, completion: { ...s.thread.completion, retentionDays: 45 } } }));
    render(<ThreadsSection />);
    const trigger = screen.getByTestId("settings-retention-trigger");
    expect(trigger).toHaveTextContent("45 days");

    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "45 days" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await act(async () => {});

    expect(trigger).toHaveTextContent("45 days");
    expect(saved().thread.completion.retentionDays).toBe(45);
  });

  it("saves Never as no automatic deletion", async () => {
    seedSettings();
    render(<ThreadsSection />);
    fireEvent.click(screen.getByTestId("settings-retention-trigger"));
    fireEvent.click(await screen.findByRole("option", { name: "Never" }));
    await act(async () => {});
    expect(saved().thread.completion.retentionDays).toBeNull();
  });

  it("shows a failed merge setting write beside the switch", async () => {
    const update = seedSettings();
    update.mockResolvedValueOnce("Settings file is read-only");
    render(<ThreadsSection />);
    const control = screen.getByRole("switch", { name: "Close threads when their PRs merge" });
    fireEvent.click(control);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings file is read-only");
    expect(control).toBeChecked();
  });
});
