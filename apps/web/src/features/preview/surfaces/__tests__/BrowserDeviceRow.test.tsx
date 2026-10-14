import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelHeaderSlotScope } from "@/components/panels/shell/PanelHeader";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ViewportCoordinator,
  type ViewportHostOperation,
} from "../../automation/services/viewportCoordinator";
import { useViewportDragStore } from "../../state/viewportDragStore";
import { BrowserDeviceRow, type BrowserDeviceRowProps } from "../BrowserDeviceRow";

function createCoordinator(apply = vi.fn(async (operation: ViewportHostOperation) => ({
  status: "applied" as const,
  applied: operation.requested,
}))) {
  const coordinator = new ViewportCoordinator({
    initial: { width: 1280, height: 800 },
    targetGeneration: 1,
    apply,
  });
  return { apply, coordinator };
}

function renderRow(
  coordinator: ViewportCoordinator,
  props: Partial<Omit<BrowserDeviceRowProps, "coordinator" | "state">> = {},
) {
  const onClose = props.onClose ?? vi.fn();
  const ui = () => (
    <TooltipProvider>
      <BrowserDeviceRow coordinator={coordinator} state={coordinator.snapshot()} onClose={onClose} {...props} />
    </TooltipProvider>
  );
  const view = render(ui());
  return { ...view, onClose, refresh: () => view.rerender(ui()) };
}

afterEach(() => {
  useViewportDragStore.getState().setEdge(null);
});

describe("BrowserDeviceRow", () => {
  it("shows the Paper controls and starts as Responsive", () => {
    const { coordinator } = createCoordinator();
    renderRow(coordinator);

    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
    expect(screen.getByRole("textbox", { name: "Viewport width" })).toHaveValue("1280");
    expect(screen.getByRole("textbox", { name: "Viewport height" })).toHaveValue("800");
    expect(screen.getByRole("button", { name: "Rotate viewport to landscape" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close viewport toolbar" })).toBeInTheDocument();
  });

  it("lists the presets in Paper order with sizes and a check on the current one", async () => {
    const user = userEvent.setup();
    const { coordinator } = createCoordinator();
    const { refresh } = renderRow(coordinator);

    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Responsive",
      "iPhone 15 Pro393 × 852",
      "Pixel 8412 × 915",
      "iPad Air820 × 1180",
      "Surface Pro 7912 × 1368",
      "Laptop1280 × 800",
      "Desktop1440 × 900",
    ]);
    expect(within(menu).getByRole("menuitemradio", { name: /^Responsive/ })).toBeChecked();

    await user.click(within(menu).getByRole("menuitemradio", { name: /iPhone 15 Pro/ }));
    await waitFor(() => expect(coordinator.snapshot().confirmed).toEqual({ width: 393, height: 852 }));
    refresh();
    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    expect(
      within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: /iPhone 15 Pro/ }),
    ).toBeChecked();
  });

  it("keeps the Responsive label when the size matches a preset the user did not pick", () => {
    const { coordinator } = createCoordinator();
    coordinator.setMode("responsive");
    renderRow(coordinator);

    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
  });

  it("rotates a chosen preset through the coordinator", async () => {
    const user = userEvent.setup();
    const { apply, coordinator } = createCoordinator();
    const { refresh } = renderRow(coordinator);

    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    await user.click(await screen.findByText("iPhone 15 Pro"));
    await waitFor(() => expect(coordinator.snapshot().confirmed.width).toBe(393));
    refresh();
    await user.click(screen.getByRole("button", { name: "Rotate viewport to landscape" }));

    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: { width: 852, height: 393 } }),
    ));
    refresh();
    expect(screen.getByRole("button", { name: "Rotate viewport to portrait" })).toBeInTheDocument();
  });

  it("clamps typed sizes to 240-2560", async () => {
    const user = userEvent.setup();
    const { apply, coordinator } = createCoordinator();
    renderRow(coordinator);

    const width = screen.getByRole("textbox", { name: "Viewport width" });
    const height = screen.getByRole("textbox", { name: "Viewport height" });
    await user.clear(width);
    await user.type(width, "100");
    await user.clear(height);
    await user.type(height, "3000{Enter}");

    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: { width: 240, height: 2560 } }),
    ));
  });

  it("puts the fitted scale percent beside Fit and offers the full zoom scale", async () => {
    const user = userEvent.setup();
    const { coordinator } = createCoordinator();
    renderRow(coordinator, { scale: 0.57 });

    const scaleTrigger = screen.getByRole("button", { name: "Viewport scale and presentation" });
    expect(scaleTrigger).toHaveTextContent("Fit");
    expect(scaleTrigger).toHaveTextContent("57%");

    await user.click(scaleTrigger);
    const menu = await screen.findByRole("menu");
    for (const zoom of ["50%", "75%", "100%", "125%", "150%", "200%"]) {
      expect(within(menu).getByRole("menuitemradio", { name: zoom })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole("menuitemradio", { name: "Actual size" }));
    expect(coordinator.snapshot().presentation).toBe("actual");
  });

  it("toggles each controlled menu from its trigger", async () => {
    const user = userEvent.setup();
    const { coordinator } = createCoordinator();
    renderRow(coordinator);

    for (const name of ["Viewport preset", "Viewport scale and presentation"]) {
      const trigger = screen.getByRole("button", { name });
      await user.click(trigger);
      expect(await screen.findByRole("menu")).toBeInTheDocument();
      await user.click(trigger);
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    }
  });

  it("closes through the × button", async () => {
    const user = userEvent.setup();
    const { coordinator } = createCoordinator();
    const { onClose } = renderRow(coordinator);

    await user.click(screen.getByRole("button", { name: "Close viewport toolbar" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("turns the field of the dragged edge amber and follows the live size", () => {
    const { coordinator } = createCoordinator();
    const { refresh } = renderRow(coordinator);
    const width = screen.getByRole("textbox", { name: "Viewport width" });
    const height = screen.getByRole("textbox", { name: "Viewport height" });
    expect(width).not.toHaveAttribute("data-dragging");

    act(() => useViewportDragStore.getState().setEdge("right"));
    expect(width).toHaveAttribute("data-dragging");
    expect(height).not.toHaveAttribute("data-dragging");

    void coordinator.requestUserResize({ width: 640, height: 800 });
    refresh();
    expect(width).toHaveValue("640");

    act(() => useViewportDragStore.getState().setEdge("bottom"));
    expect(width).not.toHaveAttribute("data-dragging");
    expect(height).toHaveAttribute("data-dragging");
  });
});

describe("BrowserDeviceRow in the panel header", () => {
  function Harness({ coordinator, open }: { readonly coordinator: ViewportCoordinator; readonly open: boolean }) {
    const [row2, setRow2] = useState<HTMLElement | null>(null);
    const [row3, setRow3] = useState<HTMLElement | null>(null);
    return (
      <TooltipProvider>
        <div ref={setRow2} data-testid="row-2" />
        <div ref={setRow3} data-testid="row-3" className="empty:hidden" />
        <PanelHeaderSlotScope active elements={{ leading: null, row2, row3 }}>
          {open ? (
            <BrowserDeviceRow coordinator={coordinator} state={coordinator.snapshot()} onClose={vi.fn()} />
          ) : null}
        </PanelHeaderSlotScope>
      </TooltipProvider>
    );
  }

  it("mounts under row 2 and never touches row 2 when it opens or closes", () => {
    const { coordinator } = createCoordinator();
    const { rerender } = render(<Harness coordinator={coordinator} open={false} />);
    const row2 = screen.getByTestId("row-2");
    const row2Before = row2.innerHTML;
    expect(screen.getByTestId("row-3")).toBeEmptyDOMElement();

    rerender(<Harness coordinator={coordinator} open />);
    expect(within(screen.getByTestId("row-3")).getByTestId("browser-device-row")).toBeInTheDocument();
    expect(row2.innerHTML).toBe(row2Before);

    rerender(<Harness coordinator={coordinator} open={false} />);
    expect(screen.getByTestId("row-3")).toBeEmptyDOMElement();
    expect(row2.innerHTML).toBe(row2Before);
  });
});
