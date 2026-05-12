import type { McodeBrowserCaptureV2 } from "@mcode/contracts";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const LONG_DIGIT_RUN_RE = /\b\d{13,}\b/g;

/**
 * Best-effort PII trimming for preview text fields before they are embedded in agent prompts.
 */
function redactSegment(s: string): string {
  return s
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(LONG_DIGIT_RUN_RE, "[redacted-digits]");
}

/**
 * Returns a shallow copy of a v2 browser capture with redacted excerpt fields.
 */
export function redactMcodeBrowserCaptureV2<T extends McodeBrowserCaptureV2>(capture: T): T {
  const next = { ...capture } as T;
  if (next.visibleTextExcerpt) {
    next.visibleTextExcerpt = redactSegment(next.visibleTextExcerpt);
  }
  if (next.headingOutline) {
    next.headingOutline = redactSegment(next.headingOutline);
  }
  if (next.interactiveOutlineExcerpt) {
    next.interactiveOutlineExcerpt = redactSegment(next.interactiveOutlineExcerpt);
  }
  if (next.consoleTail) {
    next.consoleTail = redactSegment(next.consoleTail);
  }
  if (next.htmlExcerpt) {
    next.htmlExcerpt = redactSegment(next.htmlExcerpt);
  }
  if (next.emulation?.userAgent) {
    next.emulation = { ...next.emulation, userAgent: redactSegment(next.emulation.userAgent) };
  }
  return next;
}
