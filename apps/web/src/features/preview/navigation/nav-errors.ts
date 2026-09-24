import type { PreviewPageError } from "@mcode/contracts";

/**
 * Presentation copy for one preview resolver failure code.
 * `pageEligible` splits omnibox behavior: eligible codes replace the page with
 * the error panel, while input-shape codes keep the inline hint line under the
 * omnibox. Every code still carries a page shape because Ctrl+click navigation
 * has no omnibox to hint in — any failure there opens an error tab.
 */
export interface PreviewNavErrorEntry {
  readonly kind: PreviewPageError["kind"];
  /** Headline on the error page; inline hint text for hint-only codes. */
  readonly message: string;
  /** Optional support line explaining the next useful move. */
  readonly detail?: string;
  /** Whether an omnibox failure renders the full error page. */
  readonly pageEligible: boolean;
}

/** Resolver codes returned by `preview:resolve-navigation` and `preview:navigate`. */
export const PREVIEW_NAV_ERRORS: Record<string, PreviewNavErrorEntry> = {
  "file-not-found": {
    kind: "file-not-found",
    message: "File not found",
    detail: "It may have been moved, renamed, or deleted.",
    pageEligible: true,
  },
  "not-a-file": {
    kind: "file-not-found",
    message: "Can't preview this file",
    detail: "The path exists but is not a regular file.",
    pageEligible: true,
  },
  "is-directory": {
    kind: "file-not-found",
    message: "Can't preview a folder",
    detail: "Add an index.html to preview it.",
    pageEligible: true,
  },
  "sensitive-file": {
    kind: "blocked",
    message: "This file can't be previewed",
    detail: "Preview never opens .env, credentials, keys, or .git contents.",
    pageEligible: true,
  },
  "invalid-url": {
    kind: "file-not-found",
    message: "Only http, https URLs and local file paths are supported.",
    pageEligible: false,
  },
  "empty-url": {
    kind: "file-not-found",
    message: "Enter a URL or file path.",
    pageEligible: false,
  },
  "no-workspace": {
    kind: "file-not-found",
    message: "Open a workspace to use relative file paths.",
    pageEligible: false,
  },
  "no-bounds": {
    kind: "file-not-found",
    message: "Wait for the panel to finish layout, then try again.",
    pageEligible: false,
  },
  "no-window": {
    kind: "file-not-found",
    message: "Preview is unavailable.",
    pageEligible: false,
  },
};

/** Resolves an IPC error code to a short user-visible hint. */
export function formatNavError(code: string): string {
  return PREVIEW_NAV_ERRORS[code]?.message ?? code;
}

/** True when an omnibox navigation failure should render the full error page. */
export function isPageEligibleNavError(code: string): boolean {
  return PREVIEW_NAV_ERRORS[code]?.pageEligible === true;
}

/** Builds the error-panel state for a resolver failure code. */
export function navCodeToPageError(code: string): PreviewPageError {
  const entry = PREVIEW_NAV_ERRORS[code];
  if (!entry) {
    return { kind: "network", code, message: code };
  }
  return {
    kind: entry.kind,
    code,
    message: entry.message,
    ...(entry.detail ? { detail: entry.detail } : {}),
  };
}

/**
 * Classifies a resident-webview `load-failed` failure into a page error. The
 * event's `error` may be a resolver code (when `preview.surface.navigate`
 * rejected the address before loading) or a Chromium error description; `code`
 * is the net-error name or number when one exists.
 */
export function previewPageErrorForFailure(
  error: string | null,
  code: string | number | null,
): PreviewPageError {
  if (error && PREVIEW_NAV_ERRORS[error]) {
    return navCodeToPageError(error);
  }
  if (code === "ERR_FILE_NOT_FOUND" || code === -6) {
    return {
      kind: "file-not-found",
      code: "ERR_FILE_NOT_FOUND",
      message: PREVIEW_NAV_ERRORS["file-not-found"]!.message,
      detail: PREVIEW_NAV_ERRORS["file-not-found"]!.detail,
    };
  }
  return {
    kind: "network",
    code: code === null ? "ERR_FAILED" : String(code),
    message: error ?? "Can't reach this site",
  };
}
