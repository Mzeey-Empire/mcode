import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERVIEW_DOCK_MIN_CANVAS } from "@/lib/composer-layout";
import { threadOverviewScope, useCanvasOverview } from "../overview-presentation";

const scope = threadOverviewScope({ id: "canvas-thread", workspace_id: "canvas-workspace" });

let reportCanvasWidth: (width: number) => void = () => {
  throw new Error("the canvas is not observed");
};

// jsdom has no layout, so the observer is driven by hand the way the browser drives it: once per
// frame, after layout and before paint.
class ManualResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    reportCanvasWidth = (width) => {
      const entry = { contentBoxSize: [{ inlineSize: width, blockSize: 800 }] } as unknown as ResizeObserverEntry;
      this.callback([entry], this as unknown as ResizeObserver);
    };
  }
  unobserve() {}
  disconnect() {}
}

function Canvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const { canvasWidth, overview } = useCanvasOverview(canvasRef, scope, scope.threadId);
  return <div ref={canvasRef} data-testid="canvas" data-width={canvasWidth} data-presentation={overview.presentation} />;
}

describe("useCanvasOverview", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("ResizeObserver", ManualResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1100, 800));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("undocks in the frame the canvas narrows past the dock threshold", () => {
    render(<Canvas />);
    expect(screen.getByTestId("canvas").dataset.presentation).toBe("docked");

    act(() => reportCanvasWidth(OVERVIEW_DOCK_MIN_CANVAS - 1));

    expect(screen.getByTestId("canvas").dataset.presentation).toBe("hidden");
  });

  it("docks in the frame the canvas widens past the dock threshold", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 480, 800));
    render(<Canvas />);
    expect(screen.getByTestId("canvas").dataset.presentation).toBe("hidden");

    act(() => reportCanvasWidth(OVERVIEW_DOCK_MIN_CANVAS));

    expect(screen.getByTestId("canvas").dataset.presentation).toBe("docked");
  });

  it("reports a width change that stays on one side of the threshold on the next frame", () => {
    render(<Canvas />);

    act(() => reportCanvasWidth(1000));
    expect(screen.getByTestId("canvas").dataset.width).toBe("1100");

    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId("canvas").dataset.width).toBe("1000");
    expect(screen.getByTestId("canvas").dataset.presentation).toBe("docked");
  });
});
