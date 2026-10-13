import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PanelTabStrip, type PanelTabStripAppearance, type PanelTabStripItem } from "./PanelTabStrip";

const ITEMS: readonly PanelTabStripItem[] = [
  { id: "a", label: "Terminal", icon: null },
  { id: "b", label: "Terminal (2)", icon: null },
  { id: "c", label: "Terminal (3)", icon: null },
];

/** jsdom has no layout, so the strip's scroll box is given fixed dimensions. */
function stubScrollBox({ clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number }) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
}

function renderStrip({
  appearance,
  onSelect = () => {},
  onClose = () => {},
}: {
  readonly appearance?: PanelTabStripAppearance;
  readonly onSelect?: (id: string) => void;
  readonly onClose?: (id: string) => void;
} = {}) {
  return render(
    <PanelTabStrip
      appearance={appearance}
      items={ITEMS}
      activeId="a"
      label="Terminals"
      addLabel="New terminal"
      onSelect={onSelect}
      onClose={onClose}
      onAdd={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PanelTabStrip overflow", () => {
  it("shows no scroll chevrons while every tab fits", () => {
    stubScrollBox({ clientWidth: 400, scrollWidth: 400 });
    renderStrip();
    expect(screen.queryByRole("button", { name: "Scroll tabs left" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll tabs right" })).toBeNull();
    expect(screen.getByRole("group", { name: "Terminals" }).hasAttribute("data-overflow-end")).toBe(false);
  });

  it("signals hidden tabs on the right and reveals the next one", () => {
    stubScrollBox({ clientWidth: 200, scrollWidth: 500 });
    renderStrip();
    const scroller = screen.getByRole("group", { name: "Terminals" });
    expect(scroller.getAttribute("data-overflow-end")).toBe("true");
    expect(scroller.hasAttribute("data-overflow-start")).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll tabs left" })).toHaveProperty("disabled", true);
    const right = screen.getByRole("button", { name: "Scroll tabs right" });
    expect(right).toHaveProperty("disabled", false);

    // Strip spans 0-200; tabs sit at 0-150, 150-300 and 300-450.
    const left: Record<string, number> = { a: 0, b: 150, c: 300 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const x = this.dataset.panelTab === undefined ? 0 : left[this.dataset.panelTab] ?? 0;
      const width = this.dataset.panelTab === undefined ? 200 : 150;
      return DOMRect.fromRect({ x, y: 0, width, height: 32 });
    });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    fireEvent.click(right);
    // Tab b's right edge (300) meets the strip's right edge (200).
    expect(scrollTo).toHaveBeenCalledWith({ left: 100, behavior: "smooth" });
  });

  it("still steps forward when the next tab is wider than the strip", () => {
    stubScrollBox({ clientWidth: 100, scrollWidth: 450 });
    renderStrip();
    const scroller = screen.getByRole("group", { name: "Terminals" });
    // Strip spans 0-100; each tab is 150 wide, so none can be fully shown.
    const left: Record<string, number> = { a: 0, b: 150, c: 300 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const tab = this.dataset.panelTab;
      if (tab === undefined) return DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 32 });
      return DOMRect.fromRect({ x: (left[tab] ?? 0) - scroller.scrollLeft, y: 0, width: 150, height: 32 });
    });
    const lefts: number[] = [];
    scroller.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options !== "object" || options.left === undefined) return;
      lefts.push(options.left);
      scroller.scrollLeft = options.left;
    };
    const right = screen.getByRole("button", { name: "Scroll tabs right" });
    fireEvent.click(right);
    fireEvent.click(right);
    expect(lefts).toEqual([150, 300]);
  });

  it("flips the signals once the strip is scrolled to the end", () => {
    stubScrollBox({ clientWidth: 200, scrollWidth: 500 });
    renderStrip();
    const scroller = screen.getByRole("group", { name: "Terminals" });
    scroller.scrollLeft = 300;
    fireEvent.scroll(scroller);
    expect(scroller.getAttribute("data-overflow-start")).toBe("true");
    expect(scroller.hasAttribute("data-overflow-end")).toBe(false);
    expect(screen.getByRole("button", { name: "Scroll tabs left" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Scroll tabs right" })).toHaveProperty("disabled", true);
  });

  it("turns a vertical wheel into sideways scrolling", () => {
    stubScrollBox({ clientWidth: 200, scrollWidth: 500 });
    renderStrip();
    const scroller = screen.getByRole("group", { name: "Terminals" });
    fireEvent.wheel(scroller, { deltaY: 120, deltaX: 0 });
    expect(scroller.scrollLeft).toBe(120);
  });
});

describe("PanelTabStrip browser appearance", () => {
  it("fades the hidden edge without scroll chevrons and still scrolls by wheel", () => {
    stubScrollBox({ clientWidth: 200, scrollWidth: 500 });
    renderStrip({ appearance: "browser" });
    const scroller = screen.getByRole("group", { name: "Terminals" });

    fireEvent.wheel(scroller, { deltaY: 120, deltaX: 0 });

    expect(scroller.getAttribute("data-overflow-end")).toBe("true");
    expect(screen.queryByRole("button", { name: "Scroll tabs left" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll tabs right" })).toBeNull();
    expect(scroller.scrollLeft).toBe(120);
  });

  it("selects and closes tabs through the same controls as the default strip", () => {
    const events: string[] = [];
    renderStrip({
      appearance: "browser",
      onSelect: (id) => events.push(`select:${id}`),
      onClose: (id) => events.push(`close:${id}`),
    });

    fireEvent.click(screen.getByRole("button", { name: "Terminal (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal (3)" }));

    expect(events).toEqual(["select:b", "close:c"]);
  });
});
