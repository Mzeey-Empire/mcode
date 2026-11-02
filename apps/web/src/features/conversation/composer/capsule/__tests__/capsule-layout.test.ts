import { describe, expect, it } from "vitest";
import { decideCapsuleRows, type CapsuleMeasure } from "../capsule-layout";

function measure(overrides: Partial<CapsuleMeasure> = {}): CapsuleMeasure {
  return {
    oneRowColumnPx: 400,
    hasText: true,
    hasLineBreak: false,
    overflowsOneRow: false,
    singleLineTextPx: 100,
    ...overrides,
  };
}

describe("decideCapsuleRows", () => {
  it("gives two rows when the one-row draft column is under 120px, even with no text", () => {
    expect(decideCapsuleRows(measure({ oneRowColumnPx: 119, hasText: false }), "one")).toBe("two");
  });

  it("gives one row at a 400px column with no text, even from two rows", () => {
    expect(decideCapsuleRows(measure({ hasText: false, singleLineTextPx: 0 }), "two")).toBe("one");
  });

  it("moves to two rows once the draft overflows its single line", () => {
    expect(decideCapsuleRows(measure({ overflowsOneRow: true }), "one")).toBe("two");
  });

  it("stays in one row while the draft fits its line", () => {
    expect(decideCapsuleRows(measure({ singleLineTextPx: 390 }), "one")).toBe("one");
  });

  it("stays in two rows when the text is only 30px short of the one-row column", () => {
    expect(decideCapsuleRows(measure({ singleLineTextPx: 370 }), "two")).toBe("two");
  });

  it("returns to one row when the text is 60px short of the one-row column", () => {
    expect(decideCapsuleRows(measure({ singleLineTextPx: 340 }), "two")).toBe("one");
  });

  it("stays in two rows while the draft holds a line break", () => {
    expect(decideCapsuleRows(measure({ hasLineBreak: true, singleLineTextPx: 20 }), "two")).toBe("two");
  });
});
