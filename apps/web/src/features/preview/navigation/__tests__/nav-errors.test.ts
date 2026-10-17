import { describe, expect, it } from "vitest";
import {
  formatNavError,
  isPageEligibleNavError,
  loopbackPort,
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
    expect(previewPageErrorForFailure("sensitive-file", null, null)).toMatchObject({
      kind: "blocked",
      code: "sensitive-file",
      message: "This file can't be previewed",
    });
  });

  it("classifies ERR_FILE_NOT_FOUND by string name or number", () => {
    for (const code of ["ERR_FILE_NOT_FOUND", -6] as const) {
      expect(previewPageErrorForFailure("ERR_FILE_NOT_FOUND", code, "file:///missing.html")).toMatchObject({
        kind: "file-not-found",
        message: "File not found",
      });
    }
  });

  it("maps a lost surface to a crash", () => {
    expect(previewPageErrorForFailure("surface-lost", null, "http://localhost:5173/")).toMatchObject({
      kind: "crash",
      message: "This page crashed",
    });
  });

  describe("plain words for network failures", () => {
    const cases = [
      ["a refused local port", "ERR_CONNECTION_REFUSED", -102, "http://localhost:5173/", "connection-refused", "Can't reach localhost:5173", "Nothing is listening on this port."],
      ["a refused 127.0.0.1 port", "ERR_CONNECTION_REFUSED", -102, "http://127.0.0.1:3000/app", "connection-refused", "Can't reach 127.0.0.1:3000", "Nothing is listening on this port."],
      ["a refused remote host", "ERR_CONNECTION_REFUSED", -102, "https://example.com/", "network", "Can't reach example.com", "Check the address or your connection."],
      ["an unknown host", "ERR_NAME_NOT_RESOLVED", -105, "https://nope.invalid/", "network", "Can't reach nope.invalid", "Check the address or your connection."],
      ["an offline machine", "ERR_INTERNET_DISCONNECTED", -106, "https://example.com/", "network", "Can't reach example.com", "Check the address or your connection."],
      ["a reset connection", "ERR_CONNECTION_RESET", -101, "http://localhost:8080/", "network", "Can't reach localhost:8080", "Check the address or your connection."],
    ] as const;

    it.each(cases)("%s", (_name, error, code, url, kind, message, detail) => {
      const result = previewPageErrorForFailure(error, code, url);
      expect(result).toMatchObject({ kind, message, detail });
      expect(`${result.message} ${result.detail ?? ""}`).not.toMatch(/ERR_/);
    });

    it("names no host when the address is unknown", () => {
      expect(previewPageErrorForFailure(null, null, null)).toEqual({
        kind: "network",
        code: "ERR_FAILED",
        message: "Can't reach this site",
        detail: "Check the address or your connection.",
      });
    });
  });

  describe("certificate failures", () => {
    const cases = [
      ["authority invalid", "ERR_CERT_AUTHORITY_INVALID", -202, "it's self-signed or from an unknown issuer"],
      ["date invalid", "ERR_CERT_DATE_INVALID", -201, "it has expired or isn't valid yet"],
      ["name invalid", "ERR_CERT_COMMON_NAME_INVALID", -200, "it was issued for another name"],
      ["revoked", "ERR_CERT_REVOKED", -206, "it was revoked"],
      ["any other certificate error", "ERR_CERT_INVALID", -207, "it's invalid"],
    ] as const;

    it.each(cases)("%s names the host and its reason without an error code", (_name, error, code, reason) => {
      const result = previewPageErrorForFailure(error, code, "https://localhost:4443/");
      expect(result).toMatchObject({
        kind: "certificate",
        message: "This connection isn't private",
        detail: `The certificate for localhost isn't trusted: ${reason}. Someone could be posing as this site.`,
      });
      expect(`${result.message} ${result.detail}`).not.toMatch(/ERR_/);
    });

    it("reads the number from the error text when no code is given", () => {
      expect(previewPageErrorForFailure("net::ERR_CERT_DATE_INVALID", null, "https://expired.example/")).toMatchObject({
        kind: "certificate",
      });
    });

    it("keeps a named certificate error a certificate warning when the number is missing", () => {
      // Navigation IPC reports the error by name only, and a network classification here would drop Proceed.
      expect(previewPageErrorForFailure("net::ERR_CERT_INVALID", null, "https://localhost:4443/")).toMatchObject({
        kind: "certificate",
      });
    });
  });
});

describe("loopbackPort", () => {
  it("returns the port only for loopback hosts", () => {
    expect(loopbackPort("http://localhost:5173/")).toBe("5173");
    expect(loopbackPort("http://[::1]:3000/")).toBe("3000");
    expect(loopbackPort("https://example.com:5173/")).toBeNull();
    expect(loopbackPort("not a url")).toBeNull();
  });

  it("reports the scheme's default port when the address omits it", () => {
    expect(loopbackPort("http://localhost/")).toBe("80");
    expect(loopbackPort("http://localhost:80/")).toBe("80");
    expect(loopbackPort("https://localhost/")).toBe("443");
  });
});
