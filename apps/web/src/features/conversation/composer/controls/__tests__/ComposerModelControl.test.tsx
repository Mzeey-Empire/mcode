import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReasoningLevel } from "@mcode/contracts";
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
    await userEvent.click(await screen.findByRole("switch", { name: "Fast mode" }));

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
