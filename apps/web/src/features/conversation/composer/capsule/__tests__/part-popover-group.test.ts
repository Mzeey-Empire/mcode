import { describe, expect, it } from "vitest";
import { partPopoverReducer, type PartPopoverState } from "../part-popover-group";

const CLOSED: PartPopoverState = { status: "closed" };

describe("partPopoverReducer", () => {
  it("keeps the model search text when another part opens", () => {
    const typed: PartPopoverState = { status: "open", part: "model", modelQuery: "son", modelTab: null };

    expect(partPopoverReducer(typed, { type: "open", part: "access" })).toEqual({
      status: "open",
      part: "access",
      modelQuery: "son",
      modelTab: null,
    });
  });

  it("starts with an empty search when opening from closed", () => {
    expect(partPopoverReducer(CLOSED, { type: "open", part: "model" })).toEqual({
      status: "open",
      part: "model",
      modelQuery: "",
      modelTab: null,
    });
  });

  it("ignores a dwell while everything is closed", () => {
    expect(partPopoverReducer(CLOSED, { type: "dwell", part: "model" })).toBe(CLOSED);
  });

  it("ignores a dwell on the part already open", () => {
    const open: PartPopoverState = { status: "open", part: "reasoning", modelQuery: "", modelTab: null };

    expect(partPopoverReducer(open, { type: "dwell", part: "reasoning" })).toBe(open);
  });

  it("switches on a dwell over another part and keeps the search text", () => {
    const open: PartPopoverState = { status: "open", part: "access", modelQuery: "son", modelTab: null };

    expect(partPopoverReducer(open, { type: "dwell", part: "model" })).toEqual({
      status: "open",
      part: "model",
      modelQuery: "son",
      modelTab: null,
    });
  });

  it("updates the search text while open", () => {
    const open: PartPopoverState = { status: "open", part: "model", modelQuery: "so", modelTab: null };

    expect(partPopoverReducer(open, { type: "query", text: "son" })).toEqual({ ...open, modelQuery: "son", modelTab: null });
  });

  it("closes on dismiss", () => {
    const open: PartPopoverState = { status: "open", part: "access", modelQuery: "son", modelTab: null };

    expect(partPopoverReducer(open, { type: "dismiss" })).toEqual(CLOSED);
  });
});
