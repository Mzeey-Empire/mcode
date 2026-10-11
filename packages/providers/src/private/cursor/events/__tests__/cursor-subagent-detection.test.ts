import { describe, expect, it } from "vitest";
import { extractCursorParentToolCallId } from "../cursor-subagent-detection.js";

describe("extractCursorParentToolCallId", () => {
  it("reads camelCase parentToolCallId", () => {
    expect(extractCursorParentToolCallId({ parentToolCallId: "p1" })).toBe("p1");
  });
  it("reads snake_case parent_call_id", () => {
    expect(extractCursorParentToolCallId({ parent_call_id: "p2" })).toBe("p2");
  });
  it("ignores an empty parent id", () => {
    expect(extractCursorParentToolCallId({ parent_call_id: "" })).toBeUndefined();
  });
});
