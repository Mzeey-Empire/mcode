import { createElement, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { sidePlacement } from "../side-placement";

const VIEWPORT = { width: 1440, height: 900 };
const POPUP = { width: 280, height: 140 };
const ROW = { top: 125, height: 32 };
const CARD_WIDTH = 280;

function rectFor(element: Element): DOMRect {
  const card = element.closest("[data-testid='card']");
  if (element.matches("[data-testid='card']")) {
    const left = Number((element as HTMLElement).dataset.left);
    return new DOMRect(left, 60, CARD_WIDTH, 300);
  }
  if (element.matches("[data-testid='row']") && card) {
    const left = Number((card as HTMLElement).dataset.left);
    return new DOMRect(left + 12, ROW.top, CARD_WIDTH - 24, ROW.height);
  }
  if (element.matches("[data-testid='menu']") || element.querySelector("[data-testid='menu']")) {
    return new DOMRect(0, 0, POPUP.width, POPUP.height);
  }
  return new DOMRect();
}

function CardWithSideMenu({ cardLeft }: { cardLeft: number }) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const menuProps = { ...sidePlacement(rowRef), "data-testid": "menu" };
  return createElement(
    "div",
    { "data-testid": "card", "data-slot": "popover-content", "data-left": cardLeft },
    createElement(
      Popover,
      { open: true },
      createElement(PopoverTrigger, {
        render: createElement("button", { ref: rowRef, type: "button", "data-testid": "row" }, "Workspace"),
      }),
      createElement(
        PopoverContent,
        menuProps,
        "Menu",
      ),
    ),
  );
}

async function placedMenu(cardLeft: number) {
  render(createElement(CardWithSideMenu, { cardLeft }));
  const positioner = (await screen.findByTestId("menu")).parentElement as HTMLElement;
  await waitFor(() => expect(positioner.style.transform || positioner.style.left).not.toBe(""));
  return positioner;
}

function placedBox(positioner: HTMLElement) {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(positioner.style.transform);
  if (match) return { left: Number(match[1]), top: Number(match[2]) };
  return { left: parseFloat(positioner.style.left), top: parseFloat(positioner.style.top) };
}

describe("side placement", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rectFor(this);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return rectFor(this).width;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return rectFor(this).height;
    });
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(VIEWPORT.width);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(VIEWPORT.height);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens to the left of a card at the right edge, top at the row minus 4px", async () => {
    const positioner = await placedMenu(1144);
    await waitFor(() => expect(positioner).toHaveAttribute("data-side", "left"));
    expect(placedBox(positioner)).toEqual({ left: 1144 - 8 - POPUP.width, top: ROW.top - 4 });
  });

  it("flips to the right of a card at the left edge", async () => {
    const positioner = await placedMenu(16);
    await waitFor(() => expect(positioner).toHaveAttribute("data-side", "right"));
    expect(placedBox(positioner)).toEqual({ left: 16 + CARD_WIDTH + 8, top: ROW.top - 4 });
  });

  it("falls back below the row when neither side fits", async () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(CARD_WIDTH + 40);
    const positioner = await placedMenu(20);
    await waitFor(() => expect(positioner).toHaveAttribute("data-side", "bottom"));
    expect(placedBox(positioner).top).toBe(ROW.top + ROW.height + 8);
  });
});
