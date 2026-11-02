import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCapsuleRows } from "../capsule-layout";

class FakeResizeObserver implements ResizeObserver {
  static readonly all = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeResizeObserver.all.delete(this);
  }
  static resize(target: Element) {
    for (const observer of FakeResizeObserver.all) {
      if (!observer.targets.has(target)) continue;
      const entry: ResizeObserverEntry = { target, contentRect: new DOMRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] };
      observer.callback([entry], observer);
    }
  }
}

function setWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
}

function Capsule({ hidden = false }: { readonly hidden?: boolean }) {
  const capsule = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const draft = useRef<HTMLDivElement>(null);
  const { rows } = useCapsuleRows({ capsule, left, right, draft }, { hidden });
  return (
    <div ref={capsule} data-testid="capsule" data-rows={rows}>
      {!hidden && <div ref={left} data-testid="left" />}
      <div ref={draft}>
        <div contentEditable />
      </div>
      {!hidden && <div ref={right} data-testid="right" />}
    </div>
  );
}

/** Lays the capsule out 600px wide with a 40px left group and a 200px right group: a 336px one-row draft column. */
function layOut() {
  setWidth(screen.getByTestId("capsule"), 600);
  setWidth(screen.getByTestId("left"), 40);
  setWidth(screen.getByTestId("right"), 200);
  act(() => FakeResizeObserver.resize(screen.getByTestId("capsule")));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.all.clear();
});

describe("useCapsuleRows", () => {
  it("drops to two rows when the right group widens while the capsule keeps its width", () => {
    render(<Capsule />);
    layOut();
    expect(screen.getByTestId("capsule")).toHaveAttribute("data-rows", "one");

    const right = screen.getByTestId("right");
    setWidth(right, 500);
    act(() => FakeResizeObserver.resize(right));

    expect(screen.getByTestId("capsule")).toHaveAttribute("data-rows", "two");
  });

  it("keeps watching the groups after they remount from a hidden capsule", () => {
    const { rerender } = render(<Capsule />);
    rerender(<Capsule hidden />);
    rerender(<Capsule />);
    layOut();

    const left = screen.getByTestId("left");
    setWidth(left, 340);
    act(() => FakeResizeObserver.resize(left));

    expect(screen.getByTestId("capsule")).toHaveAttribute("data-rows", "two");
  });
});
