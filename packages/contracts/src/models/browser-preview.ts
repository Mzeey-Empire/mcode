import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

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
    htmlExcerpt: z.string().max(16_000).optional(),
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
    htmlExcerpt: z.string().max(16_000).optional(),
    bounds: BrowserPreviewBoundsSchema(),
    visibleTextExcerpt: z.string().max(12_000).optional(),
    headingOutline: z.string().max(4000).optional(),
    interactiveOutlineExcerpt: z.string().max(8000).optional(),
    consoleTail: z.string().max(4000).optional(),
    viewportScroll: viewportScrollSchema.optional(),
    layoutViewport: layoutViewportSchema.optional(),
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

export type McodeBrowserCapture = McodeBrowserCaptureV1 | McodeBrowserCaptureV2;
