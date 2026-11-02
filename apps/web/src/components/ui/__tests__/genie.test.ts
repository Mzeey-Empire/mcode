import { describe, expect, it } from "vitest";
import { GENIE_CLOSE_MS, GENIE_OPEN_MS, genieShape, opennessAt, startClock, type GenieGeometry, type GenieShape } from "../genie";

// A 300x400 popup above a 60px-wide trigger whose centre sits 30px below the popup's bottom edge.
const geometry: GenieGeometry = { width: 300, height: 400, originX: 240, originY: 430, originWidth: 60 };

function widthAt(shape: GenieShape, index: number): number {
  return (shape.right[index]?.x ?? 0) - (shape.left[index]?.x ?? 0);
}

describe("genieShape", () => {
  it("leaves the open popup unsqueezed and unshifted, with room for its shadow", () => {
    const shape = genieShape(1, geometry);
    expect(shape.shift).toBe(0);
    for (const point of shape.left) expect(point.x).toBe(-44);
    for (const point of shape.right) expect(point.x).toBe(geometry.width + 44);
    expect(shape.left[0]?.y).toBe(-28);
    expect(shape.left.at(-1)?.y).toBe(geometry.height + 60);
  });

  it("folds every edge point into the trigger's throat on the trigger's centre line when closed", () => {
    const shape = genieShape(0, geometry);
    const throatLeft = geometry.originX - geometry.originWidth / 2;
    const throatRight = geometry.originX + geometry.originWidth / 2;
    for (const [side, edge] of [[shape.left, throatLeft], [shape.right, throatRight]] as const) {
      for (const point of side) {
        expect(point.x).toBeCloseTo(edge);
        expect(point.y + shape.shift).toBeCloseTo(geometry.originY);
      }
    }
  });

  it("never lets the outline pass the trigger's centre line mid-way", () => {
    for (const openness of [0.1, 0.3, 0.5, 0.7]) {
      const shape = genieShape(openness, geometry);
      for (const point of [...shape.left, ...shape.right]) {
        expect(point.y + shape.shift).toBeLessThanOrEqual(geometry.originY + 1e-9);
      }
    }
  });

  it("pinches points near the trigger harder than far ones mid-way", () => {
    const shape = genieShape(0.6, geometry);
    const near = widthAt(shape, shape.left.length - 1);
    const far = widthAt(shape, 0);
    expect(near).toBeLessThan(far);
    expect(near).toBeGreaterThanOrEqual(geometry.originWidth);
  });
});

describe("Genie clock", () => {
  it("runs a full open in GENIE_OPEN_MS and a full close in GENIE_CLOSE_MS", () => {
    const open = startClock(0, 1, GENIE_OPEN_MS);
    expect(opennessAt(open, 0)).toBe(0);
    expect(opennessAt(open, GENIE_OPEN_MS / 2)).toBe(0.5);
    expect(opennessAt(open, GENIE_OPEN_MS + 50)).toBe(1);
    const close = startClock(1, 0, GENIE_CLOSE_MS);
    expect(opennessAt(close, GENIE_CLOSE_MS)).toBe(0);
  });

  it("reverses mid-run from the current openness, taking only the time left to travel", () => {
    const open = startClock(0, 1, GENIE_OPEN_MS);
    const reached = opennessAt(open, GENIE_OPEN_MS / 4);
    const close = startClock(reached, 0, GENIE_CLOSE_MS);
    expect(opennessAt(close, 0)).toBe(0.25);
    expect(close.ms).toBe(GENIE_CLOSE_MS / 4);
    expect(opennessAt(close, GENIE_CLOSE_MS / 8)).toBe(0.125);
  });
});
