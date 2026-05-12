import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { McodeBrowserCaptureEmulationSchema } from "./preview-device-emulation.js";

/** Max lengths for {@link McodeBrowserCaptureV1} excerpt fields (matches Zod). */
export const MCODE_BROWSER_CAPTURE_V1_STRING_MAX = {
  htmlExcerpt: 16_000,
} as const;

/**
 * Max lengths for {@link McodeBrowserCaptureV2} excerpt fields (matches Zod).
 * Apply {@link clampMcodeBrowserCaptureV2} after redaction so replacements stay within limits.
 */
export const MCODE_BROWSER_CAPTURE_V2_STRING_MAX = {
  htmlExcerpt: 16_000,
  visibleTextExcerpt: 12_000,
  headingOutline: 4000,
  interactiveOutlineExcerpt: 8000,
  consoleTail: 4000,
  failedRequestUrl: 2048,
  failedRequestResourceType: 32,
  emulationLabel: 80,
  emulationUserAgent: 512,
} as const;

/** Max length for spillAppDataPath (POSIX path segments under the Mcode app data directory). */
export const MCODE_BROWSER_CAPTURE_SPILL_APP_DATA_PATH_MAX = 200;

/** Max length for {@link McodeBrowserCaptureV2.spillAbsolutePath} (native absolute path for tools). */
export const MCODE_BROWSER_CAPTURE_SPILL_ABSOLUTE_PATH_MAX = 640;

/** App-data-relative POSIX path: `browser-capture-spill/<workspaceDir>/<uuid>.json`. */
const SPILL_APP_DATA_PATH_RE =
  /^browser-capture-spill\/[a-zA-Z0-9_-]{1,80}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;

/**
 * Returns true when `value` is a validated spill path under the Mcode app data directory
 * (`getMcodeDir()`), used for IPC unlink validation.
 */
export function isBrowserCaptureSpillAppDataPath(value: string): boolean {
  return value.length <= MCODE_BROWSER_CAPTURE_SPILL_APP_DATA_PATH_MAX && SPILL_APP_DATA_PATH_RE.test(value);
}

/**
 * Spill JSON file under the Mcode app data directory when preview text exceeds inline fence caps.
 */
export const BrowserCaptureSpillFileSchema = lazySchema(() =>
  z.object({
    schemaVersion: z.literal(1),
    capturedAt: z.string(),
    pageUrl: z.string(),
    pageTitle: z.string(),
    fields: z.object({
      htmlExcerpt: z.string().optional(),
      visibleTextExcerpt: z.string().optional(),
      headingOutline: z.string().optional(),
      interactiveOutlineExcerpt: z.string().optional(),
      consoleTail: z.string().optional(),
    }),
  }),
);

export type BrowserCaptureSpillFile = z.infer<ReturnType<typeof BrowserCaptureSpillFileSchema>>;

/**
 * Bounding rectangle for a captured region in CSS pixels (viewport relative).
 * Used by preview capture payloads and future pick-to-reference flows.
 */
export const BrowserPreviewBoundsSchema = lazySchema(() =>
  z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
);

export type BrowserPreviewBounds = z.infer<ReturnType<typeof BrowserPreviewBoundsSchema>>;

/** How the preview capture was produced (viewport, drag region, or DOM element pick). */
export const BrowserPreviewCaptureKindSchema = lazySchema(() =>
  z.enum(["viewport", "region", "element"]),
);

export type BrowserPreviewCaptureKind = z.infer<
  ReturnType<typeof BrowserPreviewCaptureKindSchema>
>;

/**
 * Versioned payload for what the user pointed at in the embedded preview.
 * Pairs PNG attachments with URL, bounds, and optional DOM context for the agent.
 */
export const McodeBrowserCaptureV1Schema = lazySchema(() =>
  z.object({
    schemaVersion: z.literal(1),
    pageUrl: z.string(),
    pageTitle: z.string(),
    capturedAt: z.string(),
    captureKind: BrowserPreviewCaptureKindSchema().optional(),
    selectorHint: z.string().nullable().optional(),
    htmlExcerpt: z.string().max(MCODE_BROWSER_CAPTURE_V1_STRING_MAX.htmlExcerpt).optional(),
    bounds: BrowserPreviewBoundsSchema(),
  }),
);

export type McodeBrowserCaptureV1 = z.infer<ReturnType<typeof McodeBrowserCaptureV1Schema>>;

/**
 * Per-attachment pairing of persisted PNG id with structured preview metadata,
 * appended to outbound user prompts as a deterministic HTML-comment fence.
 */
export const AttachedBrowserCaptureV1Schema = lazySchema(() =>
  z.intersection(
    z.object({
      attachmentId: z.string(),
    }),
    McodeBrowserCaptureV1Schema(),
  ),
);

/** Capture metadata keyed to the outbound attachment UUID. */
export type AttachedBrowserCaptureV1 = z.infer<
  ReturnType<typeof AttachedBrowserCaptureV1Schema>
>;

const viewportScrollSchema = z.object({
  scrollX: z.number(),
  scrollY: z.number(),
});

const layoutViewportSchema = z.object({
  width: z.number(),
  height: z.number(),
});

const failedRequestEntrySchema = z.object({
  url: z.string().max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.failedRequestUrl),
  statusCode: z.number().int(),
  resourceType: z.string().max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.failedRequestResourceType).optional(),
});

/**
 * V2 adds agent-oriented text and diagnostics on top of V1: visible copy, headings,
 * a compact interactive outline, scroll and layout viewport, plus a recent console tail.
 */
export const McodeBrowserCaptureV2Schema = lazySchema(() =>
  z.object({
    schemaVersion: z.literal(2),
    pageUrl: z.string(),
    pageTitle: z.string(),
    capturedAt: z.string(),
    captureKind: BrowserPreviewCaptureKindSchema().optional(),
    selectorHint: z.string().nullable().optional(),
    htmlExcerpt: z.string().max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.htmlExcerpt).optional(),
    bounds: BrowserPreviewBoundsSchema(),
    visibleTextExcerpt: z
      .string()
      .max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.visibleTextExcerpt)
      .optional(),
    headingOutline: z.string().max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.headingOutline).optional(),
    interactiveOutlineExcerpt: z
      .string()
      .max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.interactiveOutlineExcerpt)
      .optional(),
    consoleTail: z.string().max(MCODE_BROWSER_CAPTURE_V2_STRING_MAX.consoleTail).optional(),
    viewportScroll: viewportScrollSchema.optional(),
    layoutViewport: layoutViewportSchema.optional(),
    /** Recent HTTP subresource failures observed in the preview session (capped, best-effort). */
    failedRequests: z.array(failedRequestEntrySchema).max(24).optional(),
    /**
     * Path under the Mcode app data directory (`getMcodeDir()`), POSIX segments, for spill JSON.
     * Present when excerpts were truncated for the fence; use with {@link spillAbsolutePath} for tools.
     */
    spillAppDataPath: z
      .string()
      .max(MCODE_BROWSER_CAPTURE_SPILL_APP_DATA_PATH_MAX)
      .regex(SPILL_APP_DATA_PATH_RE)
      .optional(),
    /** Native absolute path to the same spill file (convenience for read_file style tools). */
    spillAbsolutePath: z.string().max(MCODE_BROWSER_CAPTURE_SPILL_ABSOLUTE_PATH_MAX).optional(),
    /** Device emulation snapshot when the capture used a mobile or custom viewport frame. */
    emulation: McodeBrowserCaptureEmulationSchema().optional(),
  }),
);

export type McodeBrowserCaptureV2 = z.infer<ReturnType<typeof McodeBrowserCaptureV2Schema>>;

export const AttachedBrowserCaptureV2Schema = lazySchema(() =>
  z.intersection(
    z.object({
      attachmentId: z.string(),
    }),
    McodeBrowserCaptureV2Schema(),
  ),
);

export type AttachedBrowserCaptureV2 = z.infer<
  ReturnType<typeof AttachedBrowserCaptureV2Schema>
>;

/** Either capture schema version (outbound fence JSON may mix during migrations). */
export const AttachedBrowserCaptureSchema = lazySchema(() =>
  z.union([AttachedBrowserCaptureV1Schema(), AttachedBrowserCaptureV2Schema()]),
);

export type AttachedBrowserCapture = z.infer<ReturnType<typeof AttachedBrowserCaptureSchema>>;

function clampStrLen(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function clampOptStr(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return clampStrLen(s, max);
}

/**
 * Truncates v2 excerpt strings and failed-request fields to schema caps. Run after PII redaction
 * so expanded placeholders still fit {@link McodeBrowserCaptureV2Schema}.
 */
export function clampMcodeBrowserCaptureV2<T extends McodeBrowserCaptureV2>(capture: T): T {
  const m = MCODE_BROWSER_CAPTURE_V2_STRING_MAX;
  const next = { ...capture } as T;
  if (next.htmlExcerpt !== undefined) {
    next.htmlExcerpt = clampStrLen(next.htmlExcerpt, m.htmlExcerpt);
  }
  if (next.visibleTextExcerpt !== undefined) {
    next.visibleTextExcerpt = clampStrLen(next.visibleTextExcerpt, m.visibleTextExcerpt);
  }
  if (next.headingOutline !== undefined) {
    next.headingOutline = clampStrLen(next.headingOutline, m.headingOutline);
  }
  if (next.interactiveOutlineExcerpt !== undefined) {
    next.interactiveOutlineExcerpt = clampStrLen(next.interactiveOutlineExcerpt, m.interactiveOutlineExcerpt);
  }
  if (next.consoleTail !== undefined) {
    next.consoleTail = clampStrLen(next.consoleTail, m.consoleTail);
  }
  if (next.failedRequests !== undefined && next.failedRequests.length > 0) {
    next.failedRequests = next.failedRequests.map((e) => ({
      ...e,
      url: clampStrLen(e.url, m.failedRequestUrl),
      resourceType: clampOptStr(e.resourceType, m.failedRequestResourceType),
    }));
  }
  if (next.emulation !== undefined) {
    const e = next.emulation;
    next.emulation = {
      ...e,
      label: clampStrLen(e.label, m.emulationLabel),
      presetId: clampOptStr(e.presetId, 64),
      userAgent: clampOptStr(e.userAgent, m.emulationUserAgent),
    };
  }
  if (next.spillAbsolutePath !== undefined) {
    next.spillAbsolutePath = clampStrLen(next.spillAbsolutePath, MCODE_BROWSER_CAPTURE_SPILL_ABSOLUTE_PATH_MAX);
  }
  return next;
}

/**
 * Ensures an attached row fits {@link AttachedBrowserCaptureSchema} before fence validation.
 */
export function clampAttachedBrowserCaptureForOutbound(att: AttachedBrowserCapture): AttachedBrowserCapture {
  if (att.schemaVersion === 1) {
    const m = MCODE_BROWSER_CAPTURE_V1_STRING_MAX;
    return {
      ...att,
      htmlExcerpt:
        att.htmlExcerpt !== undefined ? clampStrLen(att.htmlExcerpt, m.htmlExcerpt) : undefined,
    };
  }
  const { attachmentId, ...rest } = att;
  return {
    attachmentId,
    ...clampMcodeBrowserCaptureV2(rest),
  };
}

export type McodeBrowserCapture = McodeBrowserCaptureV1 | McodeBrowserCaptureV2;
