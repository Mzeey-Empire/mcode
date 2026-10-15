import { describe, expect, it } from "vitest";
import { markerRect } from "../renderPageSnapshot";

const image = { width: 1600, height: 1200 };
const marker = (x: number, y: number) => ({
  displayNumber: 1,
  bounds: { x, y, width: 100, height: 40 },
});

describe("markerRect", () => {
  it("places a marker in snapshot pixels from document bounds, scroll and scale", () => {
    expect(markerRect(marker(50, 400), { x: 0, y: 300 }, 2, image)).toEqual({
      x: 100,
      y: 200,
      width: 200,
      height: 80,
    });
  });

  it("skips a marker that sits wholly above the scrolled viewport", () => {
    expect(markerRect(marker(50, 100), { x: 0, y: 300 }, 2, image)).toBeNull();
  });

  it("skips a marker that sits wholly below the screenshot", () => {
    expect(markerRect(marker(50, 700), { x: 0, y: 0 }, 2, image)).toBeNull();
  });

  it("keeps a marker that is partly inside the screenshot", () => {
    expect(markerRect(marker(50, 290), { x: 0, y: 300 }, 2, image)).not.toBeNull();
  });
});
