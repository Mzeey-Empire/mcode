import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ReviewActiveFileContext, useReviewScrollSpy } from "../useReviewScrollSpy";

const FILES = ["a.ts", "b.ts", "c.ts"].map((path) => ({ path }));
/** Header tops of a ten-line-per-file diff, so file N starts at N * 100. */
const viewer = { getTopForItem: (id: string) => ({ "a.ts": 0, "b.ts": 100, "c.ts": 200 })[id] };

/** A real element so the spy can listen for reader input; jsdom does no layout, so geometry is set by hand. */
function makeScroller(geometry = { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 }) {
  const element = document.createElement("div");
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { value, writable: true, configurable: true });
  }
  return element as HTMLElement & { scrollTop: number };
}

function setup(scroller = makeScroller()) {
  const reports: string[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ReviewActiveFileContext.Provider value={(path) => reports.push(path)}>{children}</ReviewActiveFileContext.Provider>
  );
  const scrollerRef = { current: scroller };
  const hook = renderHook(() => useReviewScrollSpy(FILES, scrollerRef, "cmp-1"), { wrapper });
  return { reports, scroller, spy: hook.result.current };
}

describe("useReviewScrollSpy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts on the first file", () => {
    expect(setup().reports).toEqual(["a.ts"]);
  });

  it("moves to a file once its header scrolls past the top, and reports each change once", () => {
    const { reports, spy } = setup();

    spy.onScroll(50, viewer);
    spy.onScroll(90, viewer);
    spy.onScroll(150, viewer);
    spy.onScroll(160, viewer);

    expect(reports).toEqual(["a.ts", "b.ts"]);
  });

  it("names the last file at the end of the range, though a short final file never reaches the top", () => {
    const { reports, scroller, spy } = setup(makeScroller({ scrollTop: 0, clientHeight: 100, scrollHeight: 250 }));

    scroller.scrollTop = 150;
    spy.onScroll(150, viewer);

    expect(reports).toEqual(["a.ts", "c.ts"]);
  });

  it("holds the jump target while the jump's own scroll events arrive", () => {
    const { reports, spy } = setup();

    spy.holdForJump("b.ts");
    spy.onScroll(100, viewer);

    expect(reports).toEqual(["a.ts", "b.ts"]);
  });

  it("lets a jump that clamps to the bottom keep its target after the hold ends", () => {
    const { reports, scroller, spy } = setup(makeScroller({ scrollTop: 0, clientHeight: 100, scrollHeight: 250 }));

    spy.holdForJump("b.ts");
    scroller.scrollTop = 150;
    spy.onScroll(150, viewer);
    vi.advanceTimersByTime(300);

    expect(reports).toEqual(["a.ts", "b.ts"]);
  });

  it.each(["wheel", "keydown", "pointerdown", "touchstart"])(
    "follows a reader who steps in with %s inside the hold",
    (inputType) => {
      const { reports, scroller, spy } = setup();

      spy.holdForJump("b.ts");
      scroller.dispatchEvent(new Event(inputType));
      spy.onScroll(10, viewer);

      expect(reports).toEqual(["a.ts", "b.ts", "a.ts"]);
    },
  );

  it("lets a second jump replace the first one's hold", () => {
    const { reports, scroller, spy } = setup();

    spy.holdForJump("b.ts");
    spy.holdForJump("c.ts");
    spy.onScroll(10, viewer);
    scroller.dispatchEvent(new Event("wheel"));

    expect(reports).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("re-reads a scrolled reader's file when the comparison refreshes in place", () => {
    const reports: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ReviewActiveFileContext.Provider value={(path) => reports.push(path)}>{children}</ReviewActiveFileContext.Provider>
    );
    const scroller = makeScroller();
    const scrollerRef = { current: scroller };
    const hook = renderHook(({ id }) => useReviewScrollSpy(FILES, scrollerRef, id), {
      wrapper,
      initialProps: { id: "cmp-1" },
    });

    scroller.scrollTop = 150;
    hook.result.current.onScroll(150, viewer);
    hook.rerender({ id: "cmp-2" });
    vi.advanceTimersByTime(50);

    expect(reports).toEqual(["a.ts", "b.ts", "b.ts"]);
  });

  it("does not restore an older file when the reader moves on before the refresh frame runs", () => {
    const reports: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ReviewActiveFileContext.Provider value={(path) => reports.push(path)}>{children}</ReviewActiveFileContext.Provider>
    );
    const scroller = makeScroller();
    const scrollerRef = { current: scroller };
    const hook = renderHook(({ id }) => useReviewScrollSpy(FILES, scrollerRef, id), {
      wrapper,
      initialProps: { id: "cmp-1" },
    });

    scroller.scrollTop = 150;
    hook.result.current.onScroll(150, viewer);
    hook.rerender({ id: "cmp-2" });
    scroller.scrollTop = 250;
    hook.result.current.onScroll(250, viewer);
    vi.advanceTimersByTime(50);

    expect(reports.at(-1)).toBe("c.ts");
  });
});
