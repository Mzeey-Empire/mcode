import { describe, it, expect } from "vitest";
import {
  isMcodeWorkspacePreviewUrl,
  mcodeWorkspacePreviewHref,
  markdownWorkspaceRefToPreviewPath,
  looksLikeWorkspaceRelativeFileRef,
} from "../workspace-preview-uri.js";

describe("workspace preview URI helpers", () => {
  it("detects mcode-workspace URLs case-insensitively on prefix", () => {
    expect(isMcodeWorkspacePreviewUrl("mcode-workspace:///a.html")).toBe(true);
    expect(isMcodeWorkspacePreviewUrl("  MCODE-WORKSPACE:///x  ")).toBe(true);
    expect(isMcodeWorkspacePreviewUrl("https://x")).toBe(false);
  });

  it("builds mcode-workspace hrefs with encoded path segments", () => {
    expect(mcodeWorkspacePreviewHref("sub/page.html")).toBe(
      "mcode-workspace:///sub/page.html",
    );
    expect(mcodeWorkspacePreviewHref("./sub/a b.html")).toBe(
      "mcode-workspace:///sub/a%20b.html",
    );
  });

  it("markdownWorkspaceRefToPreviewPath strips absolute markers and drive paths", () => {
    expect(markdownWorkspaceRefToPreviewPath("/docs/x.html")).toBe("docs/x.html");
    expect(markdownWorkspaceRefToPreviewPath("C:/x.html")).toBe("");
    expect(markdownWorkspaceRefToPreviewPath("~/x.html")).toBe("");
  });

  it("looksLikeWorkspaceRelativeFileRef accepts common agent emittable shapes", () => {
    expect(looksLikeWorkspaceRelativeFileRef("report.html")).toBe(true);
    expect(looksLikeWorkspaceRelativeFileRef("src/index.html")).toBe(true);
    expect(looksLikeWorkspaceRelativeFileRef("./preview.svg")).toBe(true);
    expect(looksLikeWorkspaceRelativeFileRef("example.com")).toBe(false);
    expect(looksLikeWorkspaceRelativeFileRef("https://a/b.html")).toBe(false);
  });

  it("looksLikeWorkspaceRelativeFileRef rejects domain-like hosts with a path", () => {
    expect(looksLikeWorkspaceRelativeFileRef("example.com/page.html")).toBe(false);
  });
});
