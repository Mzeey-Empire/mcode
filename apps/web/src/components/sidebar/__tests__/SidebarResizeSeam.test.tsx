import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarResizeSeam } from "../SidebarResizeSeam";
import { useSidebarWidthStore } from "../sidebarWidthStore";

function seam(): HTMLElement {
  return screen.getByRole("separator", { name: "Resize sidebar" });
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  setViewportWidth(1920);
  useSidebarWidthStore.getState().resetWidth();
  // jsdom has no pointer capture; the seam only needs the call to succeed.
  HTMLElement.prototype.setPointerCapture = () => {};
});

afterEach(() => {
  useSidebarWidthStore.getState().resetWidth();
});

describe("SidebarResizeSeam", () => {
  it("exposes its range and current width as a focusable separator", () => {
    render(<SidebarResizeSeam />);

    expect(seam()).toHaveAttribute("aria-orientation", "vertical");
    expect(seam()).toHaveAttribute("aria-valuemin", "220");
    expect(seam()).toHaveAttribute("aria-valuemax", "544");
    expect(seam()).toHaveAttribute("aria-valuenow", "304");
    expect(seam()).toHaveAttribute("tabindex", "0");
  });

  it("moves the edge 8px per arrow key", () => {
    render(<SidebarResizeSeam />);

    fireEvent.keyDown(seam(), { key: "ArrowRight" });
    expect(seam()).toHaveAttribute("aria-valuenow", "312");

    fireEvent.keyDown(seam(), { key: "ArrowLeft" });
    fireEvent.keyDown(seam(), { key: "ArrowLeft" });
    expect(seam()).toHaveAttribute("aria-valuenow", "296");
  });

  it("stops at the limits when stepping by keyboard", () => {
    useSidebarWidthStore.getState().setWidth(540);
    render(<SidebarResizeSeam />);

    fireEvent.keyDown(seam(), { key: "ArrowRight" });
    expect(seam()).toHaveAttribute("aria-valuenow", "544");

    act(() => useSidebarWidthStore.getState().setWidth(224));
    fireEvent.keyDown(seam(), { key: "ArrowLeft" });
    expect(seam()).toHaveAttribute("aria-valuenow", "220");
  });

  it("follows a pointer drag and clamps past either limit", () => {
    render(<SidebarResizeSeam />);

    fireEvent.pointerDown(seam(), { button: 0, pointerId: 1, clientX: 304 });
    fireEvent.pointerMove(seam(), { pointerId: 1, clientX: 264 });
    expect(useSidebarWidthStore.getState().width).toBe(264);

    fireEvent.pointerMove(seam(), { pointerId: 1, clientX: 100 });
    expect(useSidebarWidthStore.getState().width).toBe(220);

    fireEvent.pointerMove(seam(), { pointerId: 1, clientX: 900 });
    expect(useSidebarWidthStore.getState().width).toBe(544);

    fireEvent.pointerUp(seam(), { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(seam(), { pointerId: 1, clientX: 250 });
    expect(useSidebarWidthStore.getState().width).toBe(544);
  });

  it("shrinks the width and its range when the window narrows", () => {
    useSidebarWidthStore.getState().setWidth(520);
    render(<SidebarResizeSeam />);

    setViewportWidth(900);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(seam()).toHaveAttribute("aria-valuemax", "420");
    expect(seam()).toHaveAttribute("aria-valuenow", "420");
  });

  it("ignores a secondary-button drag", () => {
    render(<SidebarResizeSeam />);

    fireEvent.pointerDown(seam(), { button: 2, pointerId: 1, clientX: 304 });
    fireEvent.pointerMove(seam(), { pointerId: 1, clientX: 250 });

    expect(useSidebarWidthStore.getState().width).toBe(304);
  });

  it("returns to the default width on double-click", () => {
    useSidebarWidthStore.getState().setWidth(240);
    render(<SidebarResizeSeam />);

    fireEvent.doubleClick(seam());

    expect(seam()).toHaveAttribute("aria-valuenow", "304");
  });
});
