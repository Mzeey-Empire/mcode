import { describe, it, expect } from "vitest";
import { titleFromMessageContent, preparingStatusLabel } from "@/lib/workspace-thread";

describe("workspace-thread helpers", () => {
  it("titleFromMessageContent uses the first non-empty line and trims", () => {
    expect(titleFromMessageContent("\n\nHello\nrest")).toBe("Hello");
  });

  it("preparingStatusLabel covers new-direct", () => {
    expect(preparingStatusLabel("new-direct")).toContain("Starting");
  });
});
