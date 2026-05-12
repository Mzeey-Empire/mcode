import { describe, expect, it } from "vitest";
import { redactMcodeBrowserCaptureV2 } from "../redact.js";

describe("redactMcodeBrowserCaptureV2", () => {
  it("redacts emails and long digit runs in excerpt fields", () => {
    const capture = redactMcodeBrowserCaptureV2({
      schemaVersion: 2,
      pageUrl: "https://example.com",
      pageTitle: "t",
      capturedAt: "2026-01-01T00:00:00.000Z",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      visibleTextExcerpt: "Contact user@host.com or call 15551234567890",
      headingOutline: "Hi user@other.org",
      interactiveOutlineExcerpt: "- [a] x",
    });
    expect(capture.visibleTextExcerpt).toContain("[redacted-email]");
    expect(capture.visibleTextExcerpt).toContain("[redacted-digits]");
    expect(capture.visibleTextExcerpt).not.toContain("user@host.com");
    expect(capture.headingOutline).toContain("[redacted-email]");
    expect(capture.pageUrl).toBe("https://example.com");
  });

  it("redacts emails inside emulation userAgent snippets", () => {
    const capture = redactMcodeBrowserCaptureV2({
      schemaVersion: 2,
      pageUrl: "https://example.com",
      pageTitle: "t",
      capturedAt: "2026-01-01T00:00:00.000Z",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      emulation: {
        mode: "preset",
        label: "Phone",
        cssViewport: { width: 360, height: 800 },
        deviceScaleFactor: 2,
        userAgent: "Mozilla/5.0 Mobile dev@example.com",
      },
    });
    expect(capture.emulation?.userAgent).toContain("[redacted-email]");
  });
});
