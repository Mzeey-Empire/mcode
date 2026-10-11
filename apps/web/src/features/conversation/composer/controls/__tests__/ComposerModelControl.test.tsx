import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function renderLockedControl(branchFromMessageId?: string) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerModelControl
      threadId="thread-1"
      branchFromMessageId={branchFromMessageId}
      selection={selection}
      defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
      reasoningLevels={["low", "medium", "high"]}
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
    await userEvent.click(await screen.findByRole("button", { name: "Low" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ reasoning: "low" });
    expect(setThreadSettings).toHaveBeenCalledWith("thread-1", { reasoningLevel: "low" });
  });

  it("turns Fast on for a fork without persisting it to the source thread", async () => {
    const onSelectionChange = renderLockedControl("message-1");

    await userEvent.click(screen.getByTestId("model-selector-trigger"));
    await userEvent.click(await screen.findByTestId("composer-codex-fast-switch"));

    expect(onSelectionChange).toHaveBeenCalledWith({ codexFastMode: true });
    expect(setThreadSettings).not.toHaveBeenCalled();
  });
});
