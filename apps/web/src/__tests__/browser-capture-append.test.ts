import { describe, it, expect } from "vitest";
import { appendBrowserCaptureFence, MCODE_BROWSER_CAPTURE_FENCE_OPEN } from "@/lib/browser-capture-append";
import type { AttachedBrowserCaptureV1 } from "@mcode/contracts";

const sampleCapture: AttachedBrowserCaptureV1 = {
  attachmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  schemaVersion: 1,
  pageUrl: "https://example.com/path",
  pageTitle: "Example",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
};

describe("appendBrowserCaptureFence", () => {
  it("is a no-op when there are zero captures", () => {
    expect(appendBrowserCaptureFence("hello", [])).toBe("hello");
  });

  it("includes the opener and valid JSON payloads", () => {
    const out = appendBrowserCaptureFence("user text", [sampleCapture]);
    expect(out).toContain(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
    expect(out).toContain('"attachmentId"');
    expect(out).toContain("https://example.com/path");
  });
});
