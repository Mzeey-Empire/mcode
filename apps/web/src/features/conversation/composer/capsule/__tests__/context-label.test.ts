import { describe, expect, it } from "vitest";
import { contextLabelFor } from "../context-label";

describe("contextLabelFor", () => {
  it.each([
    { percentUsed: null, expected: null },
    { percentUsed: 69.9, expected: null },
    { percentUsed: 70, expected: { text: "70%", tone: "warning" } },
    { percentUsed: 89.9, expected: { text: "90%", tone: "warning" } },
    { percentUsed: 90, expected: { text: "90%", tone: "destructive" } },
    { percentUsed: 72.4, expected: { text: "72%", tone: "warning" } },
  ])("labels $percentUsed% used as $expected", ({ percentUsed, expected }) => {
    expect(contextLabelFor(percentUsed)).toEqual(expected);
  });
});
