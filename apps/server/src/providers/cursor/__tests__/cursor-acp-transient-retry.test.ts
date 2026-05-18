import { describe, it, expect } from "vitest";
import {
  isLikelyTransientCursorPromptFailure,
  looksLikeUpstreamStreamCancel,
} from "../cursor-acp-transient-retry.js";

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

  it("treats HTTP/2 stream cancel copy as transient for optional prompt retry", () => {
    expect(
      isLikelyTransientCursorPromptFailure(
        "Error: v: [canceled] http/2 stream closed with error code CANCEL (0x8)",
      ),
    ).toBe(true);
    expect(looksLikeUpstreamStreamCancel("[canceled] http/2 stream closed")).toBe(true);
  });

  it("returns false for likely permanent client errors", () => {
    expect(isLikelyTransientCursorPromptFailure("invalid_grant")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("ENOENT: open failed")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("Unauthorized")).toBe(false);
    expect(
      isLikelyTransientCursorPromptFailure('status CANCEL detected on stream :path "/rpc"'),
    ).toBe(false);
  });
});
