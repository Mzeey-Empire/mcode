import { describe, expect, it } from "vitest";
import {
  formatNavError,
  isPageEligibleNavError,
  navCodeToPageError,
  previewPageErrorForFailure,
} from "../nav-errors";

describe("navCodeToPageError", () => {
  it("classifies a missing file as file-not-found with the shared headline", () => {
    expect(navCodeToPageError("file-not-found")).toEqual({
      kind: "file-not-found",
      code: "file-not-found",
      message: "File not found",
      detail: "It may have been moved, renamed, or deleted.",
    });
  });

  it("distinguishes a non-file path without calling it missing", () => {
    expect(navCodeToPageError("not-a-file")).toEqual({
      kind: "file-not-found",
      code: "not-a-file",
      message: "Can't preview this file",
      detail: "The path exists but is not a regular file.",
    });
  });

  it("tells the user how to preview a folder", () => {
    const error = navCodeToPageError("is-directory");
    expect(error.message).toBe("Can't preview a folder");
    expect(error.detail).toContain("index.html");
  });

  it("maps a sensitive file to the blocked kind", () => {
    const error = navCodeToPageError("sensitive-file");
    expect(error.kind).toBe("blocked");
    expect(error.message).toBe("This file can't be previewed");
  });

  it("keeps hint-only codes renderable as a page for Ctrl+click", () => {
    const error = navCodeToPageError("no-workspace");
    expect(error.message).toBe("Open a workspace to use relative file paths.");
  });

  it("falls back to the raw code for unknown failures", () => {
    expect(navCodeToPageError("something-new")).toEqual({
      kind: "network",
      code: "something-new",
      message: "something-new",
    });
  });
});

describe("isPageEligibleNavError", () => {
  it("renders a page for missing, non-file, folder, and blocked codes", () => {
    for (const code of ["file-not-found", "not-a-file", "is-directory", "sensitive-file"]) {
      expect(isPageEligibleNavError(code)).toBe(true);
    }
  });

  it("keeps input-shape failures as inline hints", () => {
    for (const code of ["empty-url", "invalid-url", "no-workspace", "unknown"]) {
      expect(isPageEligibleNavError(code)).toBe(false);
    }
  });
});

describe("formatNavError", () => {
  it("returns the hint label for known codes", () => {
    expect(formatNavError("invalid-url")).toBe(
      "Only http, https URLs and local file paths are supported.",
    );
  });

  it("passes unknown codes through unchanged", () => {
    expect(formatNavError("unlisted-error")).toBe("unlisted-error");
  });
});

describe("previewPageErrorForFailure", () => {
  it("classifies a resolver code carried as the error string", () => {
    expect(previewPageErrorForFailure("sensitive-file", null)).toMatchObject({
      kind: "blocked",
      code: "sensitive-file",
      message: "This file can't be previewed",
    });
  });

  it("classifies ERR_FILE_NOT_FOUND by string name or number", () => {
    for (const code of ["ERR_FILE_NOT_FOUND", -6] as const) {
      expect(previewPageErrorForFailure("ERR_FILE_NOT_FOUND", code)).toMatchObject({
        kind: "file-not-found",
        message: "File not found",
      });
    }
  });

  it("keeps the raw description for other network failures", () => {
    expect(previewPageErrorForFailure("ERR_NAME_NOT_RESOLVED", -105)).toEqual({
      kind: "network",
      code: "-105",
      message: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("defaults to a generic network error when nothing is known", () => {
    expect(previewPageErrorForFailure(null, null)).toEqual({
      kind: "network",
      code: "ERR_FAILED",
      message: "Can't reach this site",
    });
  });
});
