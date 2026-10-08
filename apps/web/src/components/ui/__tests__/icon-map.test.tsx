import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as iconMap from "../icon-map";

const productIcons = Object.entries(iconMap).filter(
  (entry): entry is [string, Exclude<(typeof entry)[1], number>] =>
    typeof entry[1] === "function",
);

describe("icon-map", () => {
  it("exports one icon per DESIGN.md canonical concept", () => {
    expect(productIcons).toHaveLength(31);
  });

  it.each(productIcons)("%s renders Lucide at the 1.5px stroke and 16px size", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveClass("lucide");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
    expect(svg).toHaveAttribute("width", "16");
  });

  it("keeps the stroke when the caller sets a size", () => {
    const { container } = render(<iconMap.ErrorIcon size={32} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "32");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
  });

  it("mirrors directional icons in right-to-left layouts only", () => {
    const back = render(<iconMap.BackIcon className="text-muted" />).container.querySelector("svg");
    const send = render(<iconMap.SendIcon />).container.querySelector("svg");

    expect(back).toHaveClass("rtl:-scale-x-100", "text-muted");
    expect(send).not.toHaveClass("rtl:-scale-x-100");
  });
});
