import { describe, it, expect } from "vitest";
import { appendBrowserCaptureFence, MCODE_BROWSER_CAPTURE_FENCE_OPEN } from "@/lib/browser-capture-append";
import { AttachedBrowserCaptureSchema, type AttachedBrowserCaptureV1, type AttachedBrowserCaptureV2 } from "@mcode/contracts";

const sampleCaptureV2: AttachedBrowserCaptureV2 = {
  attachmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  schemaVersion: 2,
  pageUrl: "https://example.com/path",
  pageTitle: "Example",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  visibleTextExcerpt: "Hello world",
  headingOutline: "H1: Title",
  failedRequests: [{ url: "https://example.com/missing.css", statusCode: 404, resourceType: "stylesheet" }],
};

const sampleCaptureV1: AttachedBrowserCaptureV1 = {
  attachmentId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  schemaVersion: 1,
  pageUrl: "https://legacy.example/",
  pageTitle: "Legacy",
  capturedAt: "2026-05-08T12:00:00.000Z",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

describe("appendBrowserCaptureFence", () => {
  it("is a no-op when there are zero captures", () => {
    expect(appendBrowserCaptureFence("hello", [])).toBe("hello");
  });

  it("includes the v2 fence opener and valid JSON payloads", () => {
    const out = appendBrowserCaptureFence("user text", [sampleCaptureV2]);
    expect(out).toContain(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
    expect(out).toContain('"schemaVersion":2');
    expect(out).toContain("https://example.com/path");
    expect(out).toContain("visibleTextExcerpt");
    expect(out).toContain("failedRequests");
  });

  it("accepts legacy v1 rows through the shared schema", () => {
    const parsed = AttachedBrowserCaptureSchema().parse(sampleCaptureV1);
    expect(parsed.schemaVersion).toBe(1);
    const out = appendBrowserCaptureFence("x", [sampleCaptureV1]);
    expect(out).toContain('"schemaVersion":1');
  });
});
