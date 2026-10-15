import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ReviewActiveFileContext, useReviewScrollSpy } from "../useReviewScrollSpy";

const FILES = ["a.ts", "b.ts", "c.ts"].map((path) => ({ path }));
/** Header tops of a ten-line-per-file diff, so file N starts at N * 100. */
const viewer = { getTopForItem: (id: string) => ({ "a.ts": 0, "b.ts": 100, "c.ts": 200 })[id] };

function setup(scroller: Partial<HTMLElement> = { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 }) {
  const reports: string[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ReviewActiveFileContext.Provider value={(path) => reports.push(path)}>{children}</ReviewActiveFileContext.Provider>
  );
  const scrollerRef = { current: scroller as HTMLElement };
  const hook = renderHook(() => useReviewScrollSpy(FILES, scrollerRef, "cmp-1"), { wrapper });
  return { reports, scroller: scroller as { scrollTop: number }, spy: hook.result.current };
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
    const { reports, scroller, spy } = setup({ scrollTop: 0, clientHeight: 100, scrollHeight: 250 });

    scroller.scrollTop = 150;
    spy.onScroll(150, viewer);

    expect(reports).toEqual(["a.ts", "c.ts"]);
  });

  it("holds the jump target while the jump's own scroll events arrive, then follows the reader again", () => {
    const { reports, spy } = setup();

    spy.holdForJump("b.ts");
    spy.onScroll(10, viewer);
    expect(reports).toEqual(["a.ts", "b.ts"]);

    vi.advanceTimersByTime(300);
    spy.onScroll(10, viewer);
    expect(reports).toEqual(["a.ts", "b.ts", "a.ts"]);
  });
});
