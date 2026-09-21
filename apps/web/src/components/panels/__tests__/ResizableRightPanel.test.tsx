import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResizableRightPanel } from "../ResizableRightPanel";

describe("ResizableRightPanel", () => {
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
    expect(onWidthChange).toHaveBeenCalledWith(510, "user");

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
});
