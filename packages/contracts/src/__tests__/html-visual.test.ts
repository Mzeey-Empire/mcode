import { createMockMessage } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import { HtmlVisualSchema, MessageSchema } from "../index.js";

const visual = { title: "Latency by provider", html: "<p>chart</p>", maxHeight: 480 };

describe("HtmlVisualSchema", () => {
  it("accepts a page at the 512 KiB limit", () => {
    const html = "x".repeat(524_288);
    expect(HtmlVisualSchema().parse({ ...visual, html }).html).toHaveLength(524_288);
  });

  it("rejects a page over the limit", () => {
    expect(HtmlVisualSchema().safeParse({ ...visual, html: "x".repeat(524_289) }).success).toBe(false);
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    // "é" is two UTF-8 bytes, so this page is 524,290 bytes in 262,145 characters.
    expect(HtmlVisualSchema().safeParse({ ...visual, html: "é".repeat(262_145) }).success).toBe(false);
  });

  it("rejects an empty page and a blank title", () => {
    expect(HtmlVisualSchema().safeParse({ ...visual, html: "" }).success).toBe(false);
    expect(HtmlVisualSchema().safeParse({ ...visual, title: "   " }).success).toBe(false);
  });

  it("bounds the requested height to 80..2000 whole pixels", () => {
    expect(HtmlVisualSchema().safeParse({ ...visual, maxHeight: 80 }).success).toBe(true);
    expect(HtmlVisualSchema().safeParse({ ...visual, maxHeight: 2000 }).success).toBe(true);
    expect(HtmlVisualSchema().safeParse({ ...visual, maxHeight: 79 }).success).toBe(false);
    expect(HtmlVisualSchema().safeParse({ ...visual, maxHeight: 2001 }).success).toBe(false);
    expect(HtmlVisualSchema().safeParse({ ...visual, maxHeight: 300.5 }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(HtmlVisualSchema().safeParse({ ...visual, sandbox: "allow-same-origin" }).success).toBe(false);
  });

  it("travels on a message and rejects a malformed one", () => {
    const message = createMockMessage({
      id: "m1",
      thread_id: "t1",
      role: "system",
      content: "Visual: Latency by provider",
      timestamp: "2026-10-23T00:00:00.000Z",
      sequence: 2,
    });
    expect(MessageSchema().parse({ ...message, visual }).visual).toEqual(visual);
    expect(MessageSchema().safeParse({ ...message, visual: { ...visual, maxHeight: 0 } }).success).toBe(false);
  });
});
