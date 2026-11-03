import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListTodo } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ComposerAddMenu } from "../ComposerAddMenu";
import { ComposerCapabilityChip } from "../ComposerCapabilityChip";
import { ComposerOverlayLayout } from "../ComposerOverlaySurface";
import {
  resolveComposerCapabilities,
  type ComposerCapabilityId,
  type ResolvedComposerCapability,
} from "@/features/conversation/composer/composer-capabilities";

const COMPOSER_RECT = new DOMRect(80, 80, 640, 160);
const CLAUDE_CAPABILITIES = resolveComposerCapabilities({
  providerId: "claude",
  modelId: "claude-opus-4-7",
});
const CODEX_CAPABILITIES = resolveComposerCapabilities({
  providerId: "codex",
  modelId: "gpt-5.6-sol",
});

function renderAddMenu({
  capabilities = CLAUDE_CAPABILITIES,
  attachedCapabilityIds = new Set<ComposerCapabilityId>(),
  onAttachCapability = vi.fn(),
}: {
  capabilities?: readonly ResolvedComposerCapability[];
  attachedCapabilityIds?: ReadonlySet<ComposerCapabilityId>;
  onAttachCapability?: (capabilityId: ComposerCapabilityId) => void;
} = {}) {
  return render(
    <ComposerOverlayLayout>
      <ComposerAddMenu
        disabled={false}
        onAttachFiles={vi.fn()}
        capabilities={capabilities}
        attachedCapabilityIds={attachedCapabilityIds}
        lockedCapabilityIds={new Set()}
        onAttachCapability={onAttachCapability}
        getComposerRect={() => COMPOSER_RECT}
      />
    </ComposerOverlayLayout>,
  );
}

describe("composer capabilities", () => {
  it("floats outside the composer layout when an overlay host is available", async () => {
    const user = userEvent.setup();
    renderAddMenu();

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    const menu = screen.getByRole("menu", { name: "Add to composer" });
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");
    await waitFor(() => expect(menu.parentElement).toHaveAttribute("data-side", "top"));
    expect(screen.getByTestId("composer-overlay-host")).toBeEmptyDOMElement();
  });

  it("shows the add control label in the Mcode tooltip on hover", async () => {
    const user = userEvent.setup();
    renderAddMenu();

    await user.hover(screen.getByRole("button", { name: "Add to composer" }));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "Add to composer",
      );
    });
  });

  it.each([
    ["Plan", "plan"],
    ["Goal", "goal"],
  ] as const)("attaches %s from the composer add menu", async (label, capabilityId) => {
    const user = userEvent.setup();
    const onAttachCapability = vi.fn();
    renderAddMenu({ onAttachCapability });

    const trigger = screen.getByRole("button", { name: "Add to composer" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("menu", { name: "Add to composer" })).toBeVisible();
    await user.click(screen.getByRole("menuitemcheckbox", { name: new RegExp(label) }));

    await waitFor(() => expect(onAttachCapability).toHaveBeenCalledWith(capabilityId));
    expect(screen.queryByRole("menu", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("attaches Ultra from the composer add menu", async () => {
    const user = userEvent.setup();
    const onAttachCapability = vi.fn();
    renderAddMenu({ capabilities: CODEX_CAPABILITIES, onAttachCapability });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Ultra/ }));

    await waitFor(() => expect(onAttachCapability).toHaveBeenCalledWith("orchestration"));
    expect(screen.queryByRole("menu", { name: "Add to composer" })).not.toBeInTheDocument();
  });

  it("turns an attached capability off when the chip itself is clicked", async () => {
    const user = userEvent.setup();
    const onTurnOff = vi.fn();

    render(
      <ComposerCapabilityChip
        label="Plan"
        icon={ListTodo}
        turnOffLabel="Turn off Plan"
        onTurnOff={onTurnOff}
      />,
    );

    const chip = screen.getByRole("button", { name: "Turn off Plan" });
    expect(chip).toHaveTextContent("Plan");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(chip);
    expect(onTurnOff).toHaveBeenCalledOnce();
  });

  it("uses capability-specific icons in the add menu", async () => {
    const user = userEvent.setup();
    renderAddMenu({ capabilities: CODEX_CAPABILITIES });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    expect(
      (await screen.findByRole("menuitemcheckbox", { name: /Plan/ })).querySelector(".lucide-list-checks"),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Goal/ }).querySelector(".lucide-goal"),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Ultra/ }).querySelector(".lucide-network"),
    ).toBeTruthy();
  });

  it("shows Plan as a checked menu item while plan mode is on, and turns it off when picked", async () => {
    const user = userEvent.setup();
    const onAttachCapability = vi.fn();
    renderAddMenu({ attachedCapabilityIds: new Set(["plan"]), onAttachCapability });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    const plan = await screen.findByRole("menuitemcheckbox", { name: /Plan/ });
    expect(plan).toHaveAttribute("aria-checked", "true");
    expect(plan.querySelector(".lucide-check")).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /Goal/ })).toHaveAttribute("aria-checked", "false");

    await user.click(plan);
    await waitFor(() => expect(onAttachCapability).toHaveBeenCalledWith("plan"));
  });

  it("hides the capability section when the provider exposes no Mcode capabilities", async () => {
    const user = userEvent.setup();
    renderAddMenu({ capabilities: [] });

    await user.click(screen.getByRole("button", { name: "Add to composer" }));

    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: /Files/ })).toBeVisible();
  });

  it("returns focus to + when Escape closes the menu", async () => {
    const user = userEvent.setup();
    renderAddMenu();

    const trigger = screen.getByRole("button", { name: "Add to composer" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu", { name: "Add to composer" }).contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Add to composer" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
