import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReasoningLevel } from "@mcode/contracts";
import { ComposerModelControl } from "../ComposerModelControl";
import type { ComposerAgentSelection } from "../../draft/useComposerFormController";

// The picker UI is covered by ModelSelector tests; this file drives the selection callback directly.
vi.mock("@/components/chat/ModelSelector", () => ({
  ModelSelector: ({ onSelect }: { onSelect: (modelId: string, providerId: string) => void }) => (
    <>
      <button type="button" onClick={() => onSelect("swe-1-7", "devin")}>SWE-1.7</button>
      <button type="button" onClick={() => onSelect("swe-2", "devin")}>SWE-2</button>
    </>
  ),
}));

const selection: ComposerAgentSelection = {
  modelId: "swe-2",
  provider: "devin",
  reasoning: "max",
  interactionMode: "build",
  permissionMode: "supervised",
  approvalReviewMode: "manual",
  orchestrationMode: "standard",
  contextWindow: null,
  thinking: null,
  codexFastMode: null,
  devinMode: null,
};

function renderControl(reasoning: ReasoningLevel) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerModelControl
      selection={{ ...selection, reasoning }}
      defaults={{ contextWindow: undefined, thinking: undefined, globalCodexFast: false }}
      reasoningLevels={["medium", "high", "max"]}
      isModelLocked={false}
      isProviderLocked={false}
      onSelectionChange={onSelectionChange}
    />,
  );
  return onSelectionChange;
}

describe("ComposerModelControl Devin model switch", () => {
  it("snaps reasoning to the new family's default when it cannot express the current level", async () => {
    const onSelectionChange = renderControl("max");
    await userEvent.click(screen.getByRole("button", { name: "SWE-1.7" }));
    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "swe-1-7", provider: "devin", reasoning: "medium" });
  });

  it("keeps reasoning when the new family declares it", async () => {
    const onSelectionChange = renderControl("high");
    await userEvent.click(screen.getByRole("button", { name: "SWE-2" }));
    expect(onSelectionChange).toHaveBeenCalledWith({ modelId: "swe-2", provider: "devin" });
  });
});
