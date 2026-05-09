import { describe, it, expect } from "vitest";
import { isBrowserCaptureSpillAppDataPath } from "../browser-preview.js";

describe("isBrowserCaptureSpillAppDataPath", () => {
  it("rejects spill file names that are not RFC 4122 uuid v4", () => {
    expect(
      isBrowserCaptureSpillAppDataPath(
        "browser-capture-spill/550e8400-e29b-41d4-b716-446655440000/aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee.json",
      ),
    ).toBe(false);
  });

  it("accepts spill paths with a hashed workspace dir segment and uuid v4 file name", () => {
    expect(
      isBrowserCaptureSpillAppDataPath(
        "browser-capture-spill/a1b2c3d4e5f6789abcdef01234/550e8400-e29b-41d4-b716-446655440000.json",
      ),
    ).toBe(true);
  });

  it("accepts canonical spill paths with uuid workspace id segment when it is path-safe", () => {
    expect(
      isBrowserCaptureSpillAppDataPath(
        "browser-capture-spill/550e8400-e29b-41d4-b716-446655440000/550e8400-e29b-41d4-b716-446655440000.json",
      ),
    ).toBe(true);
  });

  it("rejects directory traversal and wrong prefixes", () => {
    expect(isBrowserCaptureSpillAppDataPath("browser-capture-spill/../secrets.json")).toBe(false);
    expect(isBrowserCaptureSpillAppDataPath(".mcode-local/mcode-browser-capture/f.json")).toBe(false);
    expect(isBrowserCaptureSpillAppDataPath("tmp/foo.json")).toBe(false);
  });
});
