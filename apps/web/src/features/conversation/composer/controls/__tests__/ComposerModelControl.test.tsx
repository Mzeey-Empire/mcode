import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderId, ReasoningLevel } from "@mcode/contracts";
import { registerProviderModels } from "@/lib/model-registry";
import { useThreadStore } from "@/stores/threadStore";
import { ComposerModelControl } from "../ComposerModelControl";
import type { ComposerAgentSelection } from "../../draft/useComposerFormController";

const selection: ComposerAgentSelection = {
  modelId: "gpt-5.6-luna",
  provider: "codex",
  reasoning: "high",
  interactionMode: "build",
  permissionMode: "supervised",
  approvalReviewMode: "manual",
  orchestrationMode: "standard",
  contextWindow: null,
  thinking: null,
  codexFastMode: null,
  devinMode: null,
};

const setThreadSettings = vi.fn();

beforeEach(() => {
  setThreadSettings.mockReset().mockResolvedValue(undefined);
  useThreadStore.setState({ setThreadSettings } as never);
});

function renderLockedControl(
  branchFromMessageId?: string,
  { reasoning = selection.reasoning, reasoningLevels = ["low", "medium", "high"] }: {
    reasoning?: ReasoningLevel;
    reasoningLevels?: ReasoningLevel[];
  } = {},
) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerModelControl
      threadId="thread-1"
      branchFromMessageId={branchFromMessageId}
      selection={{ ...selection, reasoning }}
      defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
      reasoningLevels={reasoningLevels}
      isModelLocked
      isProviderLocked
      onSelectionChange={onSelectionChange}
    />,
  );
  return onSelectionChange;
}

describe("ComposerModelControl", () => {
  it("changes and persists reasoning while the agent runs", async () => {
    const onSelectionChange = renderLockedControl();

    expect(screen.getByTestId("model-selector-trigger")).toHaveTextContent("High");
    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    const slider = await screen.findByLabelText("Reasoning effort");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    slider.focus();
    await userEvent.keyboard("{ArrowLeft}");

    expect(onSelectionChange).toHaveBeenCalledWith({ reasoning: "medium" });
    expect(setThreadSettings).toHaveBeenCalledWith("thread-1", { reasoningLevel: "medium" });
  });

  it("turns Fast on for a fork without persisting it to the source thread", async () => {
    const onSelectionChange = renderLockedControl("message-1");

    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    await userEvent.click(await screen.findByRole("button", { name: "Fast" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ codexFastMode: true });
    expect(setThreadSettings).not.toHaveBeenCalled();
  });

  it("does not move past the last reasoning level", async () => {
    const onSelectionChange = renderLockedControl();

    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    (await screen.findByLabelText("Reasoning effort")).focus();
    await userEvent.keyboard("{End}");

    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("commits the first level when the current level is not on the model's ladder", async () => {
    const onSelectionChange = renderLockedControl(undefined, { reasoning: "xhigh" });

    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    const slider = await screen.findByLabelText("Reasoning effort");
    expect(slider).toHaveAttribute("aria-valuetext", "X-High");
    slider.focus();
    await userEvent.keyboard("{Home}");

    expect(onSelectionChange).toHaveBeenCalledWith({ reasoning: "low" });
  });

  it("shows no slider when the model has a single reasoning level", async () => {
    renderLockedControl(undefined, { reasoningLevels: ["high"] });

    await userEvent.click(screen.getByTestId("model-selector-trigger"));

    expect(await screen.findByTestId("composer-settings-label")).toHaveTextContent("High");
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
  });
});

describe("ComposerModelControl model capabilities", () => {
  afterEach(() => {
    for (const provider of ["claude", "codex", "copilot"]) registerProviderModels(provider, []);
  });

  async function openControlsFor(provider: ProviderId, modelId: string) {
    render(
      <ComposerModelControl
        threadId="thread-1"
        selection={{ ...selection, provider, modelId }}
        defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
        reasoningLevels={["low", "medium", "high"]}
        isModelLocked
        isProviderLocked
        onSelectionChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    await screen.findByLabelText("Reasoning effort");
  }

  it("hides Fast for a Codex model that does not declare it", async () => {
    registerProviderModels("codex", [{ id: "gpt-9-plain", label: "GPT-9 Plain", providerId: "codex" }]);
    await openControlsFor("codex", "gpt-9-plain");
    expect(screen.queryByRole("button", { name: "Fast" })).toBeNull();
  });

  it("shows Fast for a non-Codex model that declares it", async () => {
    registerProviderModels("copilot", [
      { id: "gpt-9-quick", label: "GPT-9 Quick", providerId: "copilot", supportsFastMode: true },
    ]);
    await openControlsFor("copilot", "gpt-9-quick");
    expect(screen.getByRole("button", { name: "Fast" })).toBeInTheDocument();
  });

  it("shows the 1M toggle for the Claude 1M cohort", async () => {
    await openControlsFor("claude", "claude-opus-5-5");
    expect(screen.getByRole("button", { name: "1M context" })).toBeInTheDocument();
  });

  it("hides the 1M toggle for Haiku", async () => {
    await openControlsFor("claude", "claude-haiku-4-5");
    expect(screen.queryByRole("button", { name: "1M context" })).toBeNull();
  });

  it("hides the 1M toggle for a Claude model without context window options", async () => {
    registerProviderModels("claude", [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", providerId: "claude" }]);
    await openControlsFor("claude", "claude-opus-5-5");
    expect(screen.queryByRole("button", { name: "1M context" })).toBeNull();
  });
});
