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
  it("draws an arrow toward the trigger", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip" side="bottom">
        Open editor
      </TooltipContent>,
    );

    const arrow = tooltip.querySelector<HTMLElement>("[data-slot=tooltip-arrow]");
    expect(arrow).not.toBeNull();
    expect(arrow).toHaveAttribute("data-side", "bottom");
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
    expect(tooltip).toHaveTextContent("Copy");
  });

  it("renders no keycaps without a shortcut", async () => {
    const tooltip = await renderOpenTooltip(
      <TooltipContent data-testid="tooltip">Open editor</TooltipContent>,
    );

    expect(tooltip.querySelector("kbd")).toBeNull();
  });
});
