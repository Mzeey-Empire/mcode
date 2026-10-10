import { describe, expect, it } from "vitest";

import { resolvePreviewNavigationTarget } from "../resolve-target.js";

describe("resolvePreviewNavigationTarget", () => {
  it.each([
    ["localhost:5173", "http://localhost:5173"],
    ["app.localhost:3000", "http://app.localhost:3000"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["192.168.1.20", "http://192.168.1.20"],
    ["[::1]:5173", "http://[::1]:5173"],
    ["localhost", "http://localhost"],
    ["localhost:5173/app?x=1", "http://localhost:5173/app?x=1"],
    ["example.com", "https://example.com"],
    ["localhost.example.com", "https://localhost.example.com"],
    ["foo bar", "https://www.google.com/search?q=foo%20bar"],
    ["http://example.com", "http://example.com"],
  ])("resolves %s to %s", async (input, url) => {
    await expect(resolvePreviewNavigationTarget(input)).resolves.toEqual({ ok: true, url });
  });
});
