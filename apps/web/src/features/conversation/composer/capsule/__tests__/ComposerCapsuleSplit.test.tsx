import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { mockTransport } from "@/__tests__/mocks/transport";
import { GENIE_CLOSE_MS } from "@/components/ui/genie";
import { registerProviderModels } from "@/lib/model-registry";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useThreadStore } from "@/stores/threadStore";
import type { ProviderModelInfo } from "@/transport/types";
import { ComposerCapsuleSplit } from "../ComposerCapsuleSplit";
import { ComposerModelPreferenceSettings } from "../../controls/ComposerModelPreferences";
import { SWITCH_DWELL_MS } from "../part-popover-group";
import type { ComposerAgentSelection } from "../../draft/useComposerFormController";

// The real transport module imports the models store, so spreading it would load the store bound to the real transport.
vi.mock("@/transport", async () => ({
  ...(await vi.importActual<typeof import("@/transport/types")>("@/transport/types")),
  getTransport: () => mockTransport,
}));

const CODEX_MODELS: ProviderModelInfo[] = [
  { id: "gpt-9-deep", name: "GPT-9 Deep", supportedReasoningEfforts: ["low", "medium", "high"] },
  { id: "gpt-9-plain", name: "GPT-9 Plain" },
  { id: "gpt-9-wide", name: "GPT-9 Wide", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
];

const LEVELS: ReasoningLevel[] = ["low", "medium", "high"];

/** Longer than the picker's wait before a hovered row takes over its reasoning pane. */
const PANE_SETTLE_MS = 150;

const selection: ComposerAgentSelection = {
  modelId: "gpt-9-deep",
  provider: "codex",
  reasoning: "high",
  interactionMode: "build",
  permissionMode: "supervised",
  approvalReviewMode: "manual",
  orchestrationMode: "standard",
  contextWindow: null,
  thinking: null,
  fastMode: null,
  devinMode: null,
};

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let now = 0;

function frame(ms = 16): void {
  now += ms;
  const due = [...frames.values()];
  frames = new Map();
  act(() => due.forEach((callback) => callback(now)));
}

function realPopup(): Element | null {
  return document.querySelector('[data-slot="popover-content"]');
}

function part(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

function rest(element: HTMLElement, ms: number): void {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(ms));
}

interface SplitOverrides {
  readonly selection?: Partial<ComposerAgentSelection>;
  readonly reasoningLevels?: ReasoningLevel[];
  readonly isProviderLocked?: boolean;
  readonly permissionLocked?: boolean;
  readonly approvalReviewSupported?: boolean;
  readonly threadId?: string;
  readonly branchFromMessageId?: string;
}

async function renderSplit(overrides: SplitOverrides = {}) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerCapsuleSplit
      anchorRef={createRef<HTMLElement>()}
      threadId={overrides.threadId}
      branchFromMessageId={overrides.branchFromMessageId}
      selection={{ ...selection, ...overrides.selection }}
      defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
      reasoningLevels={overrides.reasoningLevels ?? LEVELS}
      permissionLocked={overrides.permissionLocked ?? false}
      approvalReviewSupported={overrides.approvalReviewSupported ?? true}
      isProviderLocked={overrides.isProviderLocked ?? false}
      onSelectionChange={onSelectionChange}
      onSelectionTouched={vi.fn()}
    />,
  );
  return onSelectionChange;
}

function openPart(name: RegExp): void {
  fireEvent.click(part(name));
  for (let i = 0; i < 16; i++) frame();
}

async function openModelPicker(): Promise<HTMLElement> {
  fireEvent.click(part(/^Model:/));
  // Lets the catalog request resolve.
  await act(async () => {});
  return screen.getByRole("dialog", { name: "Choose model and provider" });
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  // jsdom lays nothing out; the Genie skips popups with no size.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 240));
  registerProviderModels("codex", CODEX_MODELS.map((model) => ({
    id: model.id,
    label: model.name,
    providerId: "codex",
    supportedReasoningLevels: model.supportedReasoningEfforts,
  })));
  vi.mocked(mockTransport.listProviderModels).mockResolvedValue(CODEX_MODELS);
});

afterEach(() => {
  useProviderModelsStore.setState(useProviderModelsStore.getInitialState());
  registerProviderModels("codex", []);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ComposerCapsuleSplit", () => {
  // Live tests choose their model through these exact names in
  // .agents/skills/electorn-live-testing/scripts/pick-model.mjs, so a rename here must update that helper too.
  it("keeps the names the live-testing model picker helper drives", async () => {
    vi.mocked(mockTransport.listProviderModels).mockImplementation(async (providerId) =>
      providerId === "claude" ? [{ id: "claude-haiku-9", name: "Haiku 9" }] : CODEX_MODELS);
    const onSelectionChange = await renderSplit();

    fireEvent.click(screen.getByRole("button", { name: /^Model: / }));
    await act(async () => {});
    const picker = screen.getByRole("dialog", { name: "Choose model and provider" });
    fireEvent.click(within(picker).getByRole("radio", { name: "Claude" }));
    await act(async () => {});
    fireEvent.change(within(picker).getByPlaceholderText("Search models"), { target: { value: "Haiku" } });
    fireEvent.click(within(picker).getAllByRole("option", { name: /\bHaiku\b/ })[0]);

    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", modelId: "claude-haiku-9" }));
  });

  it("keeps the model search and its focus across hover switches", async () => {
    // Base UI returns focus only to an element `tabbable` sees, and it sees nothing in a layout-free jsdom.
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue(Object.assign([new DOMRect(0, 0, 10, 10)], { item: () => null }));
    await renderSplit();
    await openModelPicker();
    fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "son" } });

    rest(part(/^Access mode:/), SWITCH_DWELL_MS);
    await act(async () => {});
    expect(screen.getByRole("option", { selected: true })).toHaveFocus();
    rest(part(/^Model:/), SWITCH_DWELL_MS);
    await act(async () => {});

    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(search).toHaveValue("son");
    expect(search).toHaveFocus();
  });

  it("hands focus back to the part at once on Escape, without the part's tooltip", async () => {
    await renderSplit();
    await openModelPicker();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Escape" });

    expect(part(/^Model:/)).toHaveFocus();
    expect(document.querySelector("[data-slot='tooltip-content']")).not.toBeInTheDocument();
  });

  it("names the model part with the model and its reasoning level, and Fast when it is on", async () => {
    registerProviderModels("codex", [{ id: "gpt-9-deep", label: "GPT-9 Deep", providerId: "codex", supportedReasoningLevels: LEVELS, supportsFastMode: true }]);
    await renderSplit({ selection: { fastMode: true } });

    expect(screen.getByRole("button", { name: "Model: GPT-9 Deep, High reasoning, Fast" })).toHaveAttribute("data-capsule-part", "model");
    expect(screen.queryByRole("button", { name: /^Reasoning/ })).toBeNull();
  });

  it("names a part in a tooltip when focus reaches it", async () => {
    await renderSplit();

    act(() => part(/^Model: /).focus());

    expect(document.querySelector("[data-slot='tooltip-content']")).toHaveTextContent("Model: GPT-9 Deep, High reasoning");
  });

  it("lists the warm catalog across part switches without fetching it again", async () => {
    useProviderModelsStore.getState().applyModels("codex", CODEX_MODELS);
    vi.mocked(mockTransport.listProviderModels).mockClear();
    await renderSplit();
    await openModelPicker();

    rest(part(/^Access mode:/), SWITCH_DWELL_MS);
    rest(part(/^Model:/), SWITCH_DWELL_MS);
    await act(async () => {});

    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label") ?? option.textContent))
      .toEqual(expect.arrayContaining([expect.stringContaining("GPT-9 Deep"), expect.stringContaining("GPT-9 Plain")]));
    expect(mockTransport.listProviderModels).not.toHaveBeenCalled();
  });

  it("keeps the chosen provider tab across part switches and starts over after closing", async () => {
    await renderSplit();
    await openModelPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Favourites" }));

    rest(part(/^Access mode:/), SWITCH_DWELL_MS);
    rest(part(/^Model:/), SWITCH_DWELL_MS);
    expect(screen.getByRole("radio", { name: "Favourites" })).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Escape" });
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    await openModelPicker();
    expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not switch when the pointer rests just under the dwell", async () => {
    await renderSplit();
    await openModelPicker();

    rest(part(/^Access mode:/), SWITCH_DWELL_MS - 1);

    expect(screen.getByRole("dialog", { name: "Choose model and provider" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Access" })).toBeNull();
  });

  it("opens nothing when the pointer rests on a part while everything is closed", async () => {
    await renderSplit();

    rest(part(/^Model:/), SWITCH_DWELL_MS);

    expect(realPopup()).toBeNull();
  });

  it("sets model, provider and level in one change from the reasoning pane of a hovered model, and closes", async () => {
    const onSelectionChange = await renderSplit();
    await openModelPicker();

    fireEvent.mouseMove(screen.getByRole("option", { name: "GPT-9 Wide" }));
    act(() => vi.advanceTimersByTime(PANE_SETTLE_MS));
    const pane = screen.getByRole("listbox", { name: "Reasoning for GPT-9 Wide" });
    expect(within(pane).queryByRole("option", { selected: true })).toBeNull();
    fireEvent.click(within(pane).getByRole("option", { name: "X-High" }));

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "gpt-9-wide", provider: "codex", reasoning: "xhigh" });
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    expect(realPopup()).toBeNull();
  });

  it("reaches the pane from the search with Right Arrow and commits a model and level with Enter", async () => {
    const onSelectionChange = await renderSplit();
    await openModelPicker();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    expect(screen.getByRole("listbox", { name: "Reasoning for GPT-9 Deep" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High", selected: true })).toBeInTheDocument();
    const typing = user.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    await act(() => vi.advanceTimersByTimeAsync(100));
    await typing;

    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "gpt-9-wide", provider: "codex", reasoning: "xhigh" });
  });

  it("closes on a model pick, keeping a level the model supports", async () => {
    const onSelectionChange = await renderSplit();
    await openModelPicker();

    fireEvent.click(screen.getByRole("option", { name: "GPT-9 Wide" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "gpt-9-wide", provider: "codex" });
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    expect(realPopup()).toBeNull();
  });

  it("snaps to the new model's first level when it cannot express the current one", async () => {
    const onSelectionChange = await renderSplit({ selection: { modelId: "gpt-9-wide", reasoning: "xhigh" }, reasoningLevels: ["low", "medium", "high", "xhigh"] });
    await openModelPicker();

    fireEvent.click(screen.getByRole("option", { name: "GPT-9 Deep" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "gpt-9-deep", provider: "codex", reasoning: "low" });
  });

  it("closes and pours back when the new model has no reasoning levels", async () => {
    await renderSplit();
    await openModelPicker();
    for (let i = 0; i < 16; i++) frame();

    fireEvent.click(screen.getByRole("option", { name: "GPT-9 Plain" }));
    frame(0);
    frame(GENIE_CLOSE_MS - 1);
    expect(realPopup()).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-9 Plain" })).toBeInTheDocument();

    frame(1);
    expect(realPopup()).toBeNull();
  });

  it("opens the model picker while the agent runs", async () => {
    await renderSplit({ isProviderLocked: true });

    expect(await openModelPicker()).toBeInTheDocument();
  });

  it("focuses the Access option under the pointer, so the arrow keys carry on from it", async () => {
    await renderSplit();
    fireEvent.click(part(/^Access mode: Ask me/));
    for (let i = 0; i < 16; i++) frame();
    const [, hovered, next] = screen.getAllByRole("option");
    if (!hovered || !next) throw new Error("expected at least three access options");

    fireEvent.pointerMove(hovered);
    expect(hovered).toHaveFocus();
    fireEvent.keyDown(hovered, { key: "ArrowDown" });
    expect(next).toHaveFocus();
  });

  it("maps an access pick to the turn selection and closes", async () => {
    const onSelectionChange = await renderSplit();
    fireEvent.click(part(/^Access mode: Ask me/));
    for (let i = 0; i < 16; i++) frame();

    expect(screen.getByRole("option", { name: "Ask me" })).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: "Don't ask" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ permissionMode: "full", approvalReviewMode: "manual" });
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    expect(realPopup()).toBeNull();
  });
});

describe("ComposerCapsuleSplit reasoning pane", () => {
  function pane(name: string): HTMLElement {
    return screen.getByRole("listbox", { name: `Reasoning for ${name}` });
  }

  /** Registers the models and serves them as the catalog, which the picker fetches and registers again on open. */
  function serveModels(models: ProviderModelInfo[]): void {
    registerProviderModels("codex", models.map((model) => ({
      id: model.id,
      label: model.name,
      providerId: "codex",
      supportedReasoningLevels: model.supportedReasoningEfforts,
      supportsFastMode: model.supportsFastMode,
    })));
    vi.mocked(mockTransport.listProviderModels).mockResolvedValue(models);
  }

  it("sets and persists the selected model's level in one click while the agent runs, and closes", async () => {
    const setThreadSettings = vi.spyOn(useThreadStore.getState(), "setThreadSettings").mockResolvedValue(true);
    const onSelectionChange = await renderSplit({ threadId: "thread-1", isProviderLocked: true });
    await openModelPicker();

    expect(within(pane("GPT-9 Deep")).getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(pane("GPT-9 Deep")).getByRole("option", { name: "Low" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "gpt-9-deep", provider: "codex", reasoning: "low" });
    expect(setThreadSettings).toHaveBeenCalledWith("thread-1", { reasoningLevel: "low" });
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    expect(realPopup()).toBeNull();
  });

  it("keeps Fast toggling in place under the selected model's levels, and offers it on no other model", async () => {
    serveModels([
      { id: "gpt-9-deep", name: "GPT-9 Deep", supportedReasoningEfforts: LEVELS, supportsFastMode: true },
      { id: "gpt-9-wide", name: "GPT-9 Wide", supportedReasoningEfforts: LEVELS, supportsFastMode: true },
    ]);
    const onSelectionChange = await renderSplit();
    await openModelPicker();

    fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
    for (let i = 0; i < 16; i++) frame(GENIE_CLOSE_MS);
    expect(onSelectionChange).toHaveBeenCalledWith({ fastMode: true });
    expect(screen.getByRole("dialog", { name: "Choose model and provider" })).toBeInTheDocument();

    fireEvent.mouseMove(screen.getByRole("option", { name: "GPT-9 Wide" }));
    act(() => vi.advanceTimersByTime(PANE_SETTLE_MS));
    expect(pane("GPT-9 Wide")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Fast" })).toBeNull();
  });

  it("turns Fast on for a fork without persisting it to the source thread", async () => {
    const setThreadSettings = vi.spyOn(useThreadStore.getState(), "setThreadSettings").mockResolvedValue(true);
    serveModels([{ id: "gpt-9-deep", name: "GPT-9 Deep", supportsFastMode: true }]);
    const onSelectionChange = await renderSplit({ threadId: "thread-1", branchFromMessageId: "message-1" });
    await openModelPicker();

    fireEvent.click(screen.getByRole("switch", { name: "Fast" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ fastMode: true });
    expect(setThreadSettings).not.toHaveBeenCalled();
  });

  it("checks no level when the current level is not on the model's ladder", async () => {
    await renderSplit({ selection: { reasoning: "xhigh" } });
    await openModelPicker();

    expect(within(pane("GPT-9 Deep")).queryByRole("option", { selected: true })).toBeNull();
  });

  it.each([
    ["shows the 1M switch for the Claude 1M cohort", "claude-opus-5-5", true],
    ["hides the 1M switch for Haiku", "claude-haiku-4-5", false],
  ] as const)("%s", (_name, modelId, shown) => {
    render(
      <ComposerModelPreferenceSettings
        selection={{ ...selection, provider: "claude", modelId }}
        defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("switch", { name: "1M context" }) !== null).toBe(shown);
  });
});

describe("ComposerCapsuleSplit Devin model switch", () => {
  const devinModels: ProviderModelInfo[] = [
    { id: "swe-1-7", name: "SWE-1.7", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" },
    { id: "swe-2", name: "SWE-2", supportedReasoningEfforts: ["medium", "high", "max"], defaultReasoningEffort: "high" },
  ];

  beforeEach(() => {
    registerProviderModels("devin", devinModels.map((model) => ({
      id: model.id,
      label: model.name,
      providerId: "devin",
      supportedReasoningLevels: model.supportedReasoningEfforts,
      defaultReasoningLevel: model.defaultReasoningEffort,
    })));
    vi.mocked(mockTransport.listProviderModels).mockResolvedValue(devinModels);
  });

  afterEach(() => registerProviderModels("devin", []));

  it.each([
    ["snaps reasoning to the new family's default when it cannot express the current level", "SWE-1.7", { modelId: "swe-1-7", provider: "devin", reasoning: "medium" }],
    ["keeps reasoning when the new family declares it", "SWE-2", { modelId: "swe-2", provider: "devin" }],
  ] as const)("%s", async (_name, label, patch) => {
    const onSelectionChange = await renderSplit({
      selection: { provider: "devin", modelId: "swe-2", reasoning: "max" },
      reasoningLevels: ["medium", "high", "max"],
    });
    await openModelPicker();

    fireEvent.click(screen.getByRole("option", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
  });

  it("tags the model's own default level in the reasoning pane", async () => {
    await renderSplit({ selection: { provider: "devin", modelId: "swe-2", reasoning: "max" }, reasoningLevels: ["medium", "high", "max"] });
    await openModelPicker();

    const pane = screen.getByRole("listbox", { name: "Reasoning for SWE-2" });
    expect(within(pane).getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["Medium", "High, default", "Max"]);
  });
});

describe("ComposerCapsuleSplit access", () => {
  it.each([
    ["Ask me", { permissionMode: "supervised", approvalReviewMode: "manual" }],
    ["Approve for me", { permissionMode: "supervised", approvalReviewMode: "automatic" }],
    ["Don't ask", { permissionMode: "full", approvalReviewMode: "manual" }],
  ] as const)("maps %s to one atomic turn selection", async (label, patch) => {
    const onSelectionChange = await renderSplit({ selection: { permissionMode: "full" } });
    openPart(/^Access mode:/);

    fireEvent.click(screen.getByRole("option", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
  });

  it("shows only Ask me and Don't ask when the provider does not support approval review", async () => {
    await renderSplit({ approvalReviewSupported: false });
    openPart(/^Access mode: Ask me/);

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Ask me", "Don't ask"]);
  });

  it("dims locked modes with the reason and keeps Don't ask available", async () => {
    const onSelectionChange = await renderSplit({
      selection: { provider: "copilot", permissionMode: "full" },
      permissionLocked: true,
      approvalReviewSupported: false,
    });
    openPart(/^Access mode: Don't ask/);

    const askMe = screen.getByRole("option", { name: "Ask me" });
    expect(askMe).toHaveAttribute("aria-disabled", "true");
    expect(askMe).toHaveAccessibleDescription("This provider runs without approval prompts");
    fireEvent.click(askMe);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Don't ask" })).not.toHaveAttribute("aria-disabled");
  });

  it.each([
    ["Normal", { devinMode: "normal", permissionMode: "supervised" }],
    ["Accept Edits", { devinMode: "accept-edits", permissionMode: "supervised" }],
    ["Smart", { devinMode: "smart", permissionMode: "supervised" }],
    ["Bypass", { devinMode: "bypass", permissionMode: "full" }],
  ] as const)("maps Devin %s to a native mode plus permission mode", async (label, patch) => {
    const onSelectionChange = await renderSplit({ selection: { provider: "devin", modelId: "swe-2", devinMode: "smart" } });
    openPart(/^Access mode: Smart/);

    fireEvent.click(screen.getByRole("option", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
  });

  it("derives the Devin access label from permissionMode when devinMode is unset", async () => {
    await renderSplit({ selection: { provider: "devin", modelId: "swe-2", permissionMode: "full" } });

    expect(part(/^Access mode: Bypass/)).toBeInTheDocument();
  });
});
