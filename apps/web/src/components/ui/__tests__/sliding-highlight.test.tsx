import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidingHighlight } from "../sliding-highlight";

const ROW_HEIGHT = 32;
let frames: FrameRequestCallback[] = [];

/** Runs the queued animation frames after the mutation observer has delivered its records. */
async function nextFrame() {
  await Promise.resolve();
  const queued = frames;
  frames = [];
  for (const callback of queued) callback(0);
}

function rectAt(index: number): DOMRect {
  return DOMRect.fromRect({ x: 4, y: 4 + index * ROW_HEIGHT, width: 200, height: ROW_HEIGHT });
}

/** jsdom has no layout, so each row reports a box from its `data-row` position. */
function stubRowRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.getAttribute("data-row");
    return row === null ? DOMRect.fromRect({ x: 0, y: 0, width: 208, height: 200 }) : rectAt(Number(row));
  });
}

function List({ rows, active }: { readonly rows: readonly string[]; readonly active: number | null }) {
  return (
    <ul role="listbox" data-testid="group">
      <SlidingHighlight follow="data-active" />
      {rows.map((row, index) => (
        <li key={row} role="option" aria-selected={false} data-row={index} data-active={index === active || undefined}>
          {row}
        </li>
      ))}
    </ul>
  );
}

/** A menu with a rule between its first row and the rest, as Base UI marks rows: only the row under the pointer. */
function RuledMenu({ active }: { readonly active: number | null }) {
  return (
    <div role="menu" data-testid="group">
      <SlidingHighlight follow="data-highlighted" />
      <div role="menuitem" data-row={0} data-highlighted={active === 0 || undefined}>Files</div>
      <div role="separator" data-testid="rule" />
      <div role="menuitem" data-row={1} data-highlighted={active === 1 || undefined}>Plan</div>
      <div role="menuitem" data-row={2} data-highlighted={active === 2 || undefined}>Goal</div>
    </div>
  );
}

function Parts() {
  return (
    <div role="group" data-testid="group">
      <SlidingHighlight follow={{ pointer: "button" }} />
      {["Model", "Reasoning", "Access"].map((label, index) => (
        <button key={label} type="button" data-row={index}>
          {label}
        </button>
      ))}
    </div>
  );
}

function fillOf(container: HTMLElement): HTMLElement {
  const fills = container.querySelectorAll<HTMLElement>('[data-slot="sliding-highlight"]');
  expect(fills).toHaveLength(1);
  const [fill] = fills;
  if (!fill) throw new Error("no fill");
  return fill;
}

const showing = (fill: HTMLElement) => fill.dataset.on !== undefined;
const slides = (fill: HTMLElement) => fill.dataset.snap === undefined;

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  stubRowRects();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SlidingHighlight", () => {
  it("slides the fill onto the newly marked row", async () => {
    const { container, rerender } = render(<List rows={["a", "b", "c"]} active={0} />);
    await nextFrame();
    const fill = fillOf(container);
    expect(fill.style.transform).toBe("translate(4px,4px)");

    rerender(<List rows={["a", "b", "c"]} active={1} />);
    await nextFrame();
    expect(fill.style.transform).toBe(`translate(4px,${4 + ROW_HEIGHT}px)`);
    expect(fill.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(showing(fill)).toBe(true);
    expect(slides(fill)).toBe(true);
  });

  it("puts the fill on the marked row of a rebuilt list without sliding", async () => {
    const { container, rerender } = render(<List rows={["a", "b", "c"]} active={0} />);
    await nextFrame();
    const fill = fillOf(container);

    rerender(<List rows={["x", "y", "z"]} active={2} />);
    await nextFrame();
    expect(fill.style.transform).toBe(`translate(4px,${4 + 2 * ROW_HEIGHT}px)`);
    expect(showing(fill)).toBe(true);
    expect(slides(fill)).toBe(false);
  });

  it("fades out in place when nothing is marked, then fades in at the next target", async () => {
    const { container, rerender } = render(<List rows={["a", "b", "c"]} active={0} />);
    await nextFrame();
    const fill = fillOf(container);

    rerender(<List rows={["a", "b", "c"]} active={null} />);
    await nextFrame();
    expect(showing(fill)).toBe(false);
    expect(fill.style.transform).toBe("translate(4px,4px)");

    rerender(<List rows={["a", "b", "c"]} active={2} />);
    await nextFrame();
    expect(showing(fill)).toBe(true);
    expect(slides(fill)).toBe(false);
  });

  it("holds the fill while its popup pours, then places it on the row marked by then", async () => {
    const PouringList = ({ pouring, active }: { readonly pouring: boolean; readonly active: number }) => (
      <div data-pouring={pouring ? "" : undefined}>
        <List rows={["a", "b", "c"]} active={active} />
      </div>
    );
    const { container, rerender } = render(<PouringList pouring active={0} />);
    const fill = fillOf(container);
    await nextFrame();
    expect(showing(fill)).toBe(false);

    rerender(<PouringList pouring active={2} />);
    await nextFrame();
    expect(showing(fill)).toBe(false);

    rerender(<PouringList pouring={false} active={2} />);
    await nextFrame();
    expect(fill.style.transform).toBe(`translate(4px,${4 + 2 * ROW_HEIGHT}px)`);
    expect(showing(fill)).toBe(true);
  });

  it("shows no fill in a group with one option", async () => {
    const { container } = render(<List rows={["only"]} active={0} />);
    await nextFrame();
    expect(showing(fillOf(container))).toBe(false);
  });

  it("keeps the fill over a rule while the pointer crosses it, then slides it to the next row", async () => {
    const { container, rerender } = render(<RuledMenu active={0} />);
    fireEvent.pointerOver(screen.getByText("Files"));
    await nextFrame();
    const fill = fillOf(container);

    fireEvent.pointerOver(screen.getByTestId("rule"));
    rerender(<RuledMenu active={null} />);
    await nextFrame();
    expect(showing(fill)).toBe(true);
    expect(fill.style.transform).toBe("translate(4px,4px)");

    rerender(<RuledMenu active={1} />);
    await nextFrame();
    expect(fill.style.transform).toBe(`translate(4px,${4 + ROW_HEIGHT}px)`);
    expect(slides(fill)).toBe(true);
  });

  it("fades the fill once the pointer leaves the menu with no row marked", async () => {
    const { container, rerender } = render(<RuledMenu active={0} />);
    fireEvent.pointerOver(screen.getByText("Files"));
    await nextFrame();

    fireEvent.pointerOut(screen.getByText("Files"), { relatedTarget: document.body });
    rerender(<RuledMenu active={null} />);
    await nextFrame();
    expect(showing(fillOf(container))).toBe(false);
  });

  it("moves the fill to the focused part on a key press while the pointer rests on another, and back when it moves", async () => {
    const { container } = render(<Parts />);
    fireEvent.pointerOver(screen.getByRole("button", { name: "Model" }));
    await nextFrame();
    const fill = fillOf(container);
    expect(fill.style.transform).toBe("translate(4px,4px)");

    const access = screen.getByRole("button", { name: "Access" });
    access.focus();
    fireEvent.keyDown(access, { key: "ArrowRight" });
    await nextFrame();
    expect(fill.style.transform).toBe(`translate(4px,${4 + 2 * ROW_HEIGHT}px)`);

    fireEvent.pointerMove(screen.getByRole("button", { name: "Model" }));
    await nextFrame();
    expect(fill.style.transform).toBe("translate(4px,4px)");
  });
});
