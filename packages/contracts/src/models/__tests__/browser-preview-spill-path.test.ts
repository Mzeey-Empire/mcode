import { describe, it, expect } from "vitest";
import { isBrowserCaptureSpillRelativePath } from "../browser-preview.js";

describe("isBrowserCaptureSpillRelativePath", () => {
  it("accepts canonical spill paths", () => {
    expect(
      isBrowserCaptureSpillRelativePath(
        ".mcode-local/mcode-browser-capture/550e8400-e29b-41d4-b716-446655440000.json",
      ),
    ).toBe(true);
  });

  it("rejects directory traversal and wrong prefixes", () => {
    expect(isBrowserCaptureSpillRelativePath(".mcode-local/../secrets.json")).toBe(false);
    expect(isBrowserCaptureSpillRelativePath("tmp/foo.json")).toBe(false);
  });
});
