import { describe, it, expect } from "vitest";
import { isLikelyTransientCursorPromptFailure } from "../cursor-acp-transient-retry.js";

describe("isLikelyTransientCursorPromptFailure", () => {
  it("detects opaque HTTP outages and timeouts", () => {
    expect(isLikelyTransientCursorPromptFailure("Internal Server Error")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure('post failed with 503 Service Unavailable')).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("fetch failed")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("ETIMEDOUT")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("ECONNRESET while reading")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("socket hang up")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("429 Too Many Requests")).toBe(true);
  });

  it("returns false for likely permanent client errors", () => {
    expect(isLikelyTransientCursorPromptFailure("invalid_grant")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("ENOENT: open failed")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("Unauthorized")).toBe(false);
  });
});
