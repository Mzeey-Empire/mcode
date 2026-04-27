import { describe, it, expect } from "vitest";
import { formatContextWindow } from "@/components/chat/format-context-window";

describe("formatContextWindow", () => {
  it("formats 1M tokens", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
  });

  it("formats 200K tokens", () => {
    expect(formatContextWindow(200_000)).toBe("200K");
  });

  it("formats 128K tokens", () => {
    expect(formatContextWindow(128_000)).toBe("128K");
  });

  it("returns undefined for undefined input", () => {
    expect(formatContextWindow(undefined)).toBeUndefined();
  });

  it("formats 2M tokens", () => {
    expect(formatContextWindow(2_000_000)).toBe("2M");
  });

  it("formats fractional millions", () => {
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
  });

  it("rounds non-round K values", () => {
    expect(formatContextWindow(8_192)).toBe("8K");
  });
});
