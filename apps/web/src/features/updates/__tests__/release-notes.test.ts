import { describe, expect, it } from "vitest";
import { parseReleaseNotes } from "../release-notes";

describe("parseReleaseNotes", () => {
  it("reads HTML list items as plain text", () => {
    const notes = "<h2>v0.10.0</h2><ul><li>Faster <strong>startup</strong></li><li>Fix &amp; polish</li></ul>";
    expect(parseReleaseNotes(notes)).toEqual({ items: ["Faster startup", "Fix & polish"], fallback: null });
  });

  it("reads markdown bullets and numbered items", () => {
    const notes = "## What's new\n\n- Add **Update** button\n* Use `install` when idle\n1. Ship [notes](https://example.com)\n";
    expect(parseReleaseNotes(notes)).toEqual({
      items: ["Add Update button", "Use install when idle", "Ship notes"],
      fallback: null,
    });
  });

  it("keeps only the first five items", () => {
    const notes = ["a", "b", "c", "d", "e", "f", "g"].map((item) => `- ${item}`).join("\n");
    expect(parseReleaseNotes(notes).items).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("falls back to the first paragraph when there is no list", () => {
    const notes = "## v0.10.0\n\nThis release improves\nupdates.\n\nSecond paragraph.";
    expect(parseReleaseNotes(notes)).toEqual({ items: [], fallback: "This release improves updates." });
  });

  it("falls back to the first HTML paragraph after a heading", () => {
    expect(parseReleaseNotes("<h1>Title</h1><p>First <em>line</em>.</p><p>Second.</p>")).toEqual({
      items: [],
      fallback: "First line.",
    });
  });

  it("drops script bodies and leaves markup inert", () => {
    const notes = '<ul><li>Safe<script>alert("x")</script></li><li><img src=x onerror="alert(1)">Image</li></ul>';
    const parsed = parseReleaseNotes(notes);
    expect(parsed.items).toEqual(["Safe", "Image"]);
    expect(parsed.items.join(" ")).not.toMatch(/[<>]|alert/);
  });

  it("strips markdown links to their text so no URL survives", () => {
    const parsed = parseReleaseNotes("- See [details](javascript:alert(1)) and ![logo](x.png)");
    expect(parsed.items).toEqual(["See details and logo"]);
  });

  it("returns literal text for escaped markup", () => {
    expect(parseReleaseNotes("- Escaped &lt;b&gt;bold&lt;/b&gt;").items).toEqual(["Escaped <b>bold</b>"]);
  });

  it("returns nothing for empty notes", () => {
    expect(parseReleaseNotes("  \n ")).toEqual({ items: [], fallback: null });
  });
});
