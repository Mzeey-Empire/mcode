import { describe, expect, it } from "vitest";
import {
  GENIE_CLOSE_MS,
  GENIE_OPEN_MS,
  genieBandSqueeze,
  genieShape,
  opennessAt,
  startClock,
  type GenieBand,
  type GenieGeometry,
  type GenieShape,
} from "../genie";

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

function landedRow(openness: number, band: GenieBand) {
  const squeeze = genieBandSqueeze(openness, geometry, band);
  const landX = (x: number) => band.pivotX + squeeze.x + squeeze.scaleX * (x - band.pivotX);
  const landY = (y: number) => band.pivotY + squeeze.y + squeeze.scaleY * (y - band.pivotY);
  return { left: landX(0), right: landX(geometry.width), mid: landY(band.mid), squeeze };
}

const centred = (mid: number): GenieBand => ({ mid, pivotX: geometry.width / 2, pivotY: mid });

describe("genieBandSqueeze", () => {
  it("leaves every band where it is in the open popup", () => {
    for (const mid of [16, 200, 384]) {
      expect(genieBandSqueeze(1, geometry, centred(mid))).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    }
  });

  it("lands each band centred in the outline's row at its height and no wider than it", () => {
    for (const openness of [0.85, 0.7, 0.55, 0.4]) {
      const shape = genieShape(openness, geometry);
      shape.left.forEach((leftEdge, index) => {
        const rightEdge = shape.right[index];
        if (!rightEdge || leftEdge.y < 0 || leftEdge.y > geometry.height) return;
        const row = landedRow(openness, centred(leftEdge.y));
        if (row.squeeze.scaleY === 0) return;
        expect((row.left + row.right) / 2).toBeCloseTo((leftEdge.x + rightEdge.x) / 2);
        expect(row.left).toBeGreaterThanOrEqual(leftEdge.x - 1e-9);
        expect(row.right).toBeLessThanOrEqual(rightEdge.x + 1e-9);
      });
    }
  });

  it("hugs the outline to any row that has visibly narrowed, so no unsqueezed background shows beside it", () => {
    for (const openness of [0.85, 0.7, 0.55, 0.4]) {
      const shape = genieShape(openness, geometry);
      shape.left.forEach((leftEdge, index) => {
        const rightEdge = shape.right[index];
        if (!rightEdge || leftEdge.y < 0 || leftEdge.y > geometry.height) return;
        const row = landedRow(openness, centred(leftEdge.y));
        if (row.squeeze.scaleY === 0 || row.right - row.left > 0.9 * geometry.width) return;
        expect(row.left - leftEdge.x).toBeLessThan(1);
        expect(rightEdge.x - row.right).toBeLessThan(1);
      });
    }
  });

  it("squeezes the row nearest the trigger as soon as a close begins, harder than rows further up", () => {
    const near = landedRow(0.85, centred(384));
    const far = landedRow(0.85, centred(16));
    expect(near.right - near.left).toBeLessThan(0.9 * geometry.width);
    expect(near.right - near.left).toBeLessThan(far.right - far.left);
  });

  it("lands a band in the same place whatever point it scales about", () => {
    const fromCentre = landedRow(0.55, centred(300));
    const fromCorner = landedRow(0.55, { mid: 300, pivotX: 12, pivotY: 40 });
    expect(fromCorner.left).toBeCloseTo(fromCentre.left);
    expect(fromCorner.right).toBeCloseTo(fromCentre.right);
    expect(fromCorner.mid).toBeCloseTo(fromCentre.mid);
  });

  it("flattens a band to nothing once it has slid past the trigger's centre line", () => {
    for (const openness of [0.3, 0.1, 0]) {
      const { shift } = genieShape(openness, geometry);
      const passed = geometry.originY - shift + 5;
      if (passed > geometry.height) continue;
      expect(genieBandSqueeze(openness, geometry, centred(passed)).scaleY).toBe(0);
    }
    expect(genieBandSqueeze(0, geometry, centred(16)).scaleY).toBe(0);
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
