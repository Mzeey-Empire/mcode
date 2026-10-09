import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerAccessControls } from "../ComposerAccessControls";
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

function renderControls(overrides: Partial<React.ComponentProps<typeof ComposerAccessControls>> = {}) {
  const onSelectionChange = vi.fn();
  render(
    <ComposerAccessControls
      selection={selection}
      isModelLocked={false}
      permissionLocked={false}
      approvalReviewSupported
      showInlineOptions
      onSelectionChange={onSelectionChange}
      onSelectionTouched={vi.fn()}
      {...overrides}
    />,
  );
  return onSelectionChange;
}

async function openPicker(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  await screen.findByRole("menu");
  return user;
}

describe("ComposerAccessControls", () => {
  it("marks the selected mode with the neutral menu check, never the primary colour", async () => {
    renderControls();

    await openPicker(/Access mode: Ask me/);

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["Ask me", "Approve for me", "Don't ask"]);
    const askMe = screen.getByRole("menuitemradio", { name: "Ask me" });
    expect(askMe).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Don't ask" })).toHaveAttribute("aria-checked", "false");
    const check = askMe.querySelector("svg.text-ink");
    expect(check).not.toBeNull();
    expect(screen.getByRole("menu").innerHTML).not.toMatch(/primary/);
  });

  it("uses the shared permission picker for Copilot", async () => {
    const onSelectionChange = renderControls({
      selection: { ...selection, provider: "copilot" },
      approvalReviewSupported: false,
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const user = await openPicker(/Access mode: Ask me/);
    expect(screen.queryByRole("menuitemradio", { name: "Approve for me" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "Don't ask" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ permissionMode: "full", approvalReviewMode: "manual" });
  });

  it("dims locked modes with the reason and keeps Don't ask available", async () => {
    const onSelectionChange = renderControls({
      selection: { ...selection, provider: "copilot", permissionMode: "full" },
      permissionLocked: true,
      approvalReviewSupported: false,
    });

    const user = await openPicker(/Access mode: Don't ask/);

    const askMe = screen.getByRole("menuitemradio", { name: "Ask me" });
    expect(askMe).toHaveAttribute("aria-disabled", "true");
    expect(askMe).toHaveAccessibleDescription("This provider runs without approval prompts");
    await user.click(askMe);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitemradio", { name: "Don't ask" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    ["Ask me", { permissionMode: "supervised", approvalReviewMode: "manual" }],
    ["Approve for me", { permissionMode: "supervised", approvalReviewMode: "automatic" }],
    ["Don't ask", { permissionMode: "full", approvalReviewMode: "manual" }],
  ] as const)("maps %s to one atomic turn selection", async (label, patch) => {
    const onSelectionChange = renderControls();

    const user = await openPicker(/Access mode: Ask me/);
    await user.click(screen.getByRole("menuitemradio", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it.each([["inline", true], ["menu", false]] as const)("shows only Ask me and Don't ask in the %s control when the provider does not support approval review", async (_surface, showInlineOptions) => {
    renderControls({ approvalReviewSupported: false, showInlineOptions });

    await openPicker(/Access mode: Ask me/);

    expect(screen.getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["Ask me", "Don't ask"]);
  });

  it("updates the picker when the provider stops offering Approve for me", async () => {
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <ComposerAccessControls
        selection={{ ...selection, approvalReviewMode: "automatic" }}
        isModelLocked={false}
        permissionLocked={false}
        approvalReviewSupported
        showInlineOptions={false}
        onSelectionChange={onSelectionChange}
        onSelectionTouched={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Access mode: Approve for me/ })).toBeInTheDocument();
    rerender(
      <ComposerAccessControls
        selection={{ ...selection, approvalReviewMode: "automatic" }}
        isModelLocked={false}
        permissionLocked={false}
        approvalReviewSupported={false}
        showInlineOptions={false}
        onSelectionChange={onSelectionChange}
        onSelectionTouched={vi.fn()}
      />,
    );
    await openPicker(/Access mode: Ask me/);

    expect(screen.queryByRole("menuitemradio", { name: "Approve for me" })).not.toBeInTheDocument();
  });

  it.each([
    ["Normal", { devinMode: "normal", permissionMode: "supervised" }],
    ["Accept Edits", { devinMode: "accept-edits", permissionMode: "supervised" }],
    ["Smart", { devinMode: "smart", permissionMode: "supervised" }],
    ["Bypass", { devinMode: "bypass", permissionMode: "full" }],
  ] as const)("maps Devin %s to a native mode plus permission mode", async (label, patch) => {
    const onSelectionChange = renderControls({
      selection: { ...selection, provider: "devin", devinMode: "smart" },
    });

    const user = await openPicker(/Access mode: Smart/);
    await user.click(screen.getByRole("menuitemradio", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
  });

  it("derives the Devin access label from permissionMode when devinMode is unset", () => {
    renderControls({
      selection: { ...selection, provider: "devin", permissionMode: "full" },
    });

    expect(screen.getByRole("button", { name: /Access mode: Bypass/ })).toBeInTheDocument();
  });
});
