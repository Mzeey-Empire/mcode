import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ViewportCoordinator,
  type ViewportHostOperation,
} from "../../automation/services/viewportCoordinator";
import { useViewportDragStore } from "../../state/viewportDragStore";
import { BrowserViewportCanvas } from "../BrowserViewportCanvas";

function setup() {
  const apply = vi.fn(async (operation: ViewportHostOperation) => ({
    status: "applied" as const,
    applied: operation.requested,
  }));
  const coordinator = new ViewportCoordinator({
    initial: { width: 800, height: 600 },
    mode: "responsive",
    targetGeneration: 1,
    apply,
  });
  return { apply, coordinator };
}

describe("BrowserViewportCanvas", () => {
  it("exposes the right and bottom edges as keyboard resize zones and no others", async () => {
    const user = userEvent.setup();
    const { apply, coordinator } = setup();
    render(
      <BrowserViewportCanvas
        coordinator={coordinator}
        state={coordinator.snapshot()}
        bounds={{ width: 1_000, height: 800 }}
        scale={1}
      >
        <div data-testid="viewport-content" />
      </BrowserViewportCanvas>,
    );

    expect(screen.getAllByRole("separator").map((handle) => handle.getAttribute("aria-label"))).toEqual([
      "Resize viewport from right",
      "Resize viewport from bottom",
    ]);
    for (const position of ["right", "bottom"]) {
      expect(screen.getByRole("separator", { name: `Resize viewport from ${position}` })).toHaveClass(
        "pointer-events-auto",
      );
    }
    expect(screen.getByTestId("browser-viewport-stage")).toHaveClass("pointer-events-none");

    await user.click(screen.getByRole("separator", { name: "Resize viewport from right" }));
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("separator", { name: "Resize viewport from bottom" }));
    await user.keyboard("{ArrowDown}");

    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      requested: { width: 816, height: 616 },
    })));
  });

  it("uses pointer capture and coalesces drag requests through the same coordinator", () => {
    const { apply, coordinator } = setup();
    render(
      <BrowserViewportCanvas
        coordinator={coordinator}
        state={coordinator.snapshot()}
        bounds={{ width: 1_000, height: 800 }}
        scale={0.5}
      >
        <div data-testid="viewport-content" />
      </BrowserViewportCanvas>,
    );
    const handle = screen.getByRole("separator", { name: "Resize viewport from right" });
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(handle, "hasPointerCapture", { value: vi.fn(() => true) });
    Object.defineProperty(handle, "releasePointerCapture", { value: vi.fn() });

    const frame = screen.getByTestId("responsive-viewport-canvas");
    expect(useViewportDragStore.getState().edge).toBeNull();

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    });
    expect(useViewportDragStore.getState().edge).toBe("right");
    expect(handle.firstElementChild).toHaveClass("bg-primary");
    expect(frame).toHaveClass("ring-primary");
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 60, clientY: 10 }));
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 110, clientY: 10 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 110, clientY: 10 }));
    });

    expect(useViewportDragStore.getState().edge).toBeNull();
    expect(handle.firstElementChild).not.toHaveClass("bg-primary");
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      requested: { width: 1_000, height: 600 },
    }));
    expect(apply.mock.calls.length).toBeGreaterThan(0);
  });

  it("clears the dragged edge when the canvas unmounts mid-drag", () => {
    const { coordinator } = setup();
    const { unmount } = render(
      <BrowserViewportCanvas
        coordinator={coordinator}
        state={coordinator.snapshot()}
        bounds={{ width: 1_000, height: 800 }}
        scale={1}
      >
        <div />
      </BrowserViewportCanvas>,
    );
    const handle = screen.getByRole("separator", { name: "Resize viewport from bottom" });
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(handle, "hasPointerCapture", { value: vi.fn(() => true) });
    Object.defineProperty(handle, "releasePointerCapture", { value: vi.fn() });
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    });
    expect(useViewportDragStore.getState().edge).toBe("bottom");

    unmount();

    expect(useViewportDragStore.getState().edge).toBeNull();
  });
});
