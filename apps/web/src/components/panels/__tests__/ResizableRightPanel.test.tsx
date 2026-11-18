import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ResizableRightPanel } from "../ResizableRightPanel";

/** A controlled panel that keeps the width it is given, as RightPanel does through its store. */
function StatefulPanel({ initialWidth }: { initialWidth: number }) {
  const [width, setWidth] = useState(initialWidth);
  return (
    <ResizableRightPanel
      width={width}
      minWidth={400}
      maxWidth="calc(100% - 480px)"
      getMaxWidth={() => 900}
      defaultWidth={500}
      wideWidth={700}
      separatorLabel="Resize test panel"
      onWidthChange={(next) => setWidth(next)}
    >
      <div>Panel content</div>
    </ResizableRightPanel>
  );
}

describe("ResizableRightPanel", () => {
  it("tells a keyboard user the seam's width and the keys that resize it", () => {
    render(<StatefulPanel initialWidth={500} />);
    const separator = screen.getByRole("separator", { name: "Resize test panel" });

    expect(separator).toHaveAttribute("aria-valuetext", "500 pixels wide");
    expect(separator).toHaveAccessibleDescription(/arrows resize/i);

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).not.toHaveAttribute("aria-valuetext", "500 pixels wide");
  });

  it("reports drag and keyboard width changes through the controlled seam", () => {
    const onWidthChange = vi.fn();
    render(
      <ResizableRightPanel
        width={500}
        minWidth={320}
        maxWidth="calc(100% - 320px)"
        getMaxWidth={() => 760}
        defaultWidth={500}
        wideWidth={700}
        separatorLabel="Resize test panel"
        onWidthChange={onWidthChange}
      >
        <div>Panel content</div>
      </ResizableRightPanel>,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize test panel",
    });
    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 450 });
    fireEvent.mouseUp(document);
    expect(onWidthChange).toHaveBeenCalledWith(550, "user");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(516, "user");

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onWidthChange).toHaveBeenCalledWith(700, "user");
  });

  it("requests collapse when a drag runs past the min-width snap distance", () => {
    const onWidthChange = vi.fn();
    const onCollapseRequest = vi.fn();
    render(
      <ResizableRightPanel
        width={500}
        minWidth={320}
        maxWidth="calc(100% - 320px)"
        getMaxWidth={() => 760}
        defaultWidth={500}
        wideWidth={700}
        separatorLabel="Resize test panel"
        onWidthChange={onWidthChange}
        onCollapseRequest={onCollapseRequest}
      >
        <div>Panel content</div>
      </ResizableRightPanel>,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize test panel",
    });
    fireEvent.mouseDown(separator, { clientX: 500 });
    // candidate = startWidth + startX - clientX. minWidth 320, snap 64:
    // collapse once the raw drag dips below 256, i.e. clientX past 744.
    fireEvent.mouseMove(document, { clientX: 700 });
    expect(onCollapseRequest).not.toHaveBeenCalled();
    expect(onWidthChange).toHaveBeenLastCalledWith(320, "user");
    fireEvent.mouseMove(document, { clientX: 760 });
    expect(onCollapseRequest).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(document);
  });

  it("resizes by 1.6rem per arrow, 4.8rem with Shift, and widens toward the seam's left edge", () => {
    render(<StatefulPanel initialWidth={500} />);
    const separator = screen.getByRole("separator", { name: "Resize test panel" });

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "516");
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "468");
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "516");
  });

  it("jumps to the minimum and maximum widths with Home and End and clamps arrows at them", () => {
    render(<StatefulPanel initialWidth={500} />);
    const separator = screen.getByRole("separator", { name: "Resize test panel" });
    expect(separator).toHaveAttribute("aria-valuemin", "400");
    expect(separator).toHaveAttribute("aria-valuemax", "900");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "400");
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "400");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "900");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "900");
  });

  it("announces the settled width once the resize key is released, not on each repeat", () => {
    render(<StatefulPanel initialWidth={500} />);
    const separator = screen.getByRole("separator", { name: "Resize test panel" });
    const status = screen.getByRole("status");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "ArrowLeft", repeat: true });
    expect(status).toHaveTextContent("");

    fireEvent.keyUp(separator, { key: "ArrowLeft" });
    expect(status).toHaveTextContent("Panel width 532 pixels");
  });
});
