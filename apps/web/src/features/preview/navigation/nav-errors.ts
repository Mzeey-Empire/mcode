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

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);

/** The effective port of a loopback URL (80 or 443 when omitted), or null for any other host or an unparseable address. */
export function loopbackPort(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return null;
    // URL drops a scheme's default port, but a server tile records the port it actually listens on.
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

const NET_ERROR_NUMBERS: Readonly<Record<string, number>> = {
  ERR_FILE_NOT_FOUND: -6,
  ERR_CONNECTION_REFUSED: -102,
  ERR_CERT_COMMON_NAME_INVALID: -200,
  ERR_CERT_DATE_INVALID: -201,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_CERT_REVOKED: -206,
  ERR_CERT_INVALID: -207,
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: -208,
  ERR_CERT_WEAK_KEY: -211,
  ERR_CERT_NAME_CONSTRAINT_VIOLATION: -212,
  ERR_CERT_VALIDITY_TOO_LONG: -213,
};

function isCertificateError(number: number): boolean {
  return number <= -200 && number >= -299;
}

function netErrorNumber(error: string | null, code: string | number | null): number | null {
  if (typeof code === "number") return code;
  for (const text of [code, error]) {
    if (text === null) continue;
    if (/^-\d+$/.test(text)) return Number(text);
    const known = NET_ERROR_NUMBERS[text.replace(/^net::/, "")];
    if (known !== undefined) return known;
  }
  return null;
}

const CERTIFICATE_REASONS: Readonly<Record<number, string>> = {
  [NET_ERROR_NUMBERS.ERR_CERT_AUTHORITY_INVALID!]: "it's self-signed or from an unknown issuer",
  [NET_ERROR_NUMBERS.ERR_CERT_DATE_INVALID!]: "it has expired or isn't valid yet",
  [NET_ERROR_NUMBERS.ERR_CERT_COMMON_NAME_INVALID!]: "it was issued for another name",
  [NET_ERROR_NUMBERS.ERR_CERT_REVOKED!]: "it was revoked",
};

function addressParts(url: string | null): { readonly host: string; readonly hostname: string } | null {
  if (!url) return null;
  try {
    const { host, hostname } = new URL(url);
    return host ? { host, hostname } : null;
  } catch {
    return null;
  }
}

function unreachableError(number: number | null, code: string | number | null, url: string | null): PreviewPageError {
  const address = addressParts(url);
  const diagnostic = code === null ? "ERR_FAILED" : String(code);
  const message = address ? `Can't reach ${address.host}` : "Can't reach this site";
  if (number === NET_ERROR_NUMBERS.ERR_CONNECTION_REFUSED && url !== null && loopbackPort(url) !== null) {
    return { kind: "connection-refused", code: diagnostic, message, detail: "Nothing is listening on this port." };
  }
  return { kind: "network", code: diagnostic, message, detail: "Check the address or your connection." };
}

function certificateWarning(
  number: number,
  error: string | null,
  code: string | number | null,
  hostname: string,
): PreviewPageError {
  const named = [error, code].find((text): text is string => typeof text === "string" && text.includes("ERR_"));
  return {
    kind: "certificate",
    code: named ?? String(code ?? number),
    message: "This connection isn't private",
    detail: `The certificate for ${hostname} isn't trusted: ${CERTIFICATE_REASONS[number] ?? "it's invalid"}. Someone could be posing as this site.`,
  };
}

/**
 * Classifies a resident-webview `load-failed` failure into a page error. The
 * event's `error` may be a resolver code (when `preview.surface.navigate`
 * rejected the address before loading) or a Chromium error description; `code`
 * is the net-error name or number when one exists, and `url` is the address
 * that failed, which names the host in the plain-words headline.
 */
export function previewPageErrorForFailure(
  error: string | null,
  code: string | number | null,
  url: string | null,
): PreviewPageError {
  if (error && PREVIEW_NAV_ERRORS[error]) {
    return navCodeToPageError(error);
  }
  if (error === "surface-lost") {
    return { kind: "crash", message: "This page crashed", detail: "Reload to open it again." };
  }
  const number = netErrorNumber(error, code);
  if (number === NET_ERROR_NUMBERS.ERR_FILE_NOT_FOUND) {
    return {
      kind: "file-not-found",
      code: "ERR_FILE_NOT_FOUND",
      message: PREVIEW_NAV_ERRORS["file-not-found"]!.message,
      detail: PREVIEW_NAV_ERRORS["file-not-found"]!.detail,
    };
  }
  const address = addressParts(url);
  if (number !== null && isCertificateError(number) && address) {
    return certificateWarning(number, error, code, address.hostname);
  }
  return unreachableError(number, code, url);
}
