import {
  AttachedBrowserCaptureV1Schema,
  type AttachedBrowserCaptureV1,
} from "@mcode/contracts";

/** Opens the machine-readable fenced block appended to outbound user prompts. */
export const MCODE_BROWSER_CAPTURE_FENCE_OPEN = "<!-- mcode-browser-capture-v1 -->";

/** Closes the machine-readable fenced block appended to outbound user prompts. */
export const MCODE_BROWSER_CAPTURE_FENCE_CLOSE = "<!-- /mcode-browser-capture-v1 -->";

/**
 * Appends a stable HTML-comment fence describing preview screenshot metadata
 * (URL, bounds, timestamps) keyed by attachment UUID. Omit when `captures` is empty.
 */
export function appendBrowserCaptureFence(prompt: string, captures: AttachedBrowserCaptureV1[]): string {
  if (captures.length === 0) return prompt;
  const validated = captures.map((c) => AttachedBrowserCaptureV1Schema().parse(c));
  return `${prompt.trimEnd()}\n\n${MCODE_BROWSER_CAPTURE_FENCE_OPEN}\n${JSON.stringify(validated)}\n${MCODE_BROWSER_CAPTURE_FENCE_CLOSE}\n`;
}
