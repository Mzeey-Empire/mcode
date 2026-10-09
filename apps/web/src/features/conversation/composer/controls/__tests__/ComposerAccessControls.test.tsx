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

    await openPicker(/Access mode: Manual/);

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["Manual", "Auto", "Full access"]);
    const manual = screen.getByRole("menuitemradio", { name: "Manual" });
    expect(manual).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toHaveAttribute("aria-checked", "false");
    const check = manual.querySelector("svg.text-ink");
    expect(check).not.toBeNull();
    expect(screen.getByRole("menu").innerHTML).not.toMatch(/primary/);
  });

  it("uses the shared permission picker for Copilot", async () => {
    const onSelectionChange = renderControls({
      selection: { ...selection, provider: "copilot" },
      approvalReviewSupported: false,
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const user = await openPicker(/Access mode: Manual/);
    expect(screen.queryByRole("menuitemradio", { name: "Auto" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "Full access" }));

    expect(onSelectionChange).toHaveBeenCalledWith({ permissionMode: "full", approvalReviewMode: "manual" });
  });

  it("dims locked modes with the reason and keeps Full access available", async () => {
    const onSelectionChange = renderControls({
      selection: { ...selection, provider: "copilot", permissionMode: "full" },
      permissionLocked: true,
      approvalReviewSupported: false,
    });

    const user = await openPicker(/Access mode: Full access/);

    const manual = screen.getByRole("menuitemradio", { name: "Manual" });
    expect(manual).toHaveAttribute("aria-disabled", "true");
    expect(manual).toHaveAccessibleDescription("This provider only runs with Full access");
    await user.click(manual);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    ["Manual", { permissionMode: "supervised", approvalReviewMode: "manual" }],
    ["Auto", { permissionMode: "supervised", approvalReviewMode: "automatic" }],
    ["Full access", { permissionMode: "full", approvalReviewMode: "manual" }],
  ] as const)("maps %s to one atomic turn selection", async (label, patch) => {
    const onSelectionChange = renderControls();

    const user = await openPicker(/Access mode: Manual/);
    await user.click(screen.getByRole("menuitemradio", { name: label }));

    expect(onSelectionChange).toHaveBeenCalledWith(patch);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it.each([["inline", true], ["menu", false]] as const)("shows only Manual and Full access in the %s control when the provider does not support approval review", async (_surface, showInlineOptions) => {
    renderControls({ approvalReviewSupported: false, showInlineOptions });

    await openPicker(/Access mode: Manual/);

    expect(screen.getAllByRole("menuitemradio").map((row) => row.textContent)).toEqual(["Manual", "Full access"]);
  });

  it("updates the picker when switching from an Auto provider to a provider without Auto", async () => {
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

    expect(screen.getByRole("button", { name: /Access mode: Auto/ })).toBeInTheDocument();
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
    await openPicker(/Access mode: Manual/);

    expect(screen.queryByRole("menuitemradio", { name: "Auto" })).not.toBeInTheDocument();
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
