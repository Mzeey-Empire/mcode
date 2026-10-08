import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

function renderOpenTooltip(content: React.ReactNode) {
  render(
    <Tooltip open>
      <TooltipTrigger render={<button type="button">Open editor</button>} />
      {content}
    </Tooltip>,
  );
  return screen.findByTestId("tooltip");
}

describe("TooltipContent", () => {
  it("renders the surface recipe by default", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip">Open editor</TooltipContent>,
    );

    // Role tokens resolve per theme, so the same classes give the surface in dark and light.
    expect(tooltip).toHaveClass(
      "bg-panel",
      "border",
      "border-border",
      "rounded-menu",
      "min-h-control-compact",
      "px-3",
      "max-w-80",
      "text-caption",
      "text-ink",
    );
    expect(tooltip.className).not.toMatch(/\bbg-ink\b|\btext-background\b|\bshadow-/);
  });

  it("fades without zooming or sliding", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip">Open editor</TooltipContent>,
    );

    expect(tooltip).toHaveClass(
      "transition-opacity",
      "duration-(--duration-standard)",
      "data-starting-style:opacity-0",
      "data-ending-style:opacity-0",
    );
    expect(tooltip.className).not.toMatch(/zoom-|slide-/);
  });

  it("draws an arrow in the surface colours toward the trigger", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip" side="bottom">
        Open editor
      </TooltipContent>,
    );

    const arrow = tooltip.querySelector<HTMLElement>("[data-slot=tooltip-arrow]");
    expect(arrow).not.toBeNull();
    expect(arrow).toHaveAttribute("data-side", "bottom");
    expect(arrow).toHaveClass("fill-panel", "stroke-border");
    expect(arrow?.querySelector("svg")).not.toBeNull();
  });

  it("shows a shortcut as one keycap per key", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip" shortcut={["Ctrl", "C"]}>
        Copy
      </TooltipContent>,
    );

    const keycaps = within(tooltip).getAllByText(/^(Ctrl|C)$/);
    expect(keycaps.map((keycap) => keycap.tagName)).toEqual(["KBD", "KBD"]);
    expect(keycaps.map((keycap) => keycap.textContent)).toEqual(["Ctrl", "C"]);
    expect(keycaps[0]).toHaveClass("h-5", "min-w-5", "rounded-sm", "font-mono", "text-caption");
    expect(tooltip).toHaveTextContent("Copy");
  });

  it("renders no keycaps without a shortcut", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip">Open editor</TooltipContent>,
    );

    expect(tooltip.querySelector("kbd")).toBeNull();
  });
});
