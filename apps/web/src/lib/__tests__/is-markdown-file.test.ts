import { describe, it, expect } from "vitest";
import { isMarkdownFile } from "@/lib/diff-parser";

describe("isMarkdownFile", () => {
  it("returns true for .md files", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guides/foo.md")).toBe(true);
  });

  it("returns true for .mdx files", () => {
    expect(isMarkdownFile("apps/web/src/page.mdx")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isMarkdownFile("README.MD")).toBe(true);
    expect(isMarkdownFile("NOTES.Md")).toBe(true);
  });

  it("returns false for non-markdown files", () => {
    expect(isMarkdownFile("src/index.ts")).toBe(false);
    expect(isMarkdownFile("package.json")).toBe(false);
    expect(isMarkdownFile("notes.md.bak")).toBe(false);
  });

  it("returns false for empty or missing paths", () => {
    expect(isMarkdownFile("")).toBe(false);
  });

  it("returns false for paths that merely contain 'md'", () => {
    expect(isMarkdownFile("md")).toBe(false);
    expect(isMarkdownFile("some/mdirectory/file.ts")).toBe(false);
  });
});
