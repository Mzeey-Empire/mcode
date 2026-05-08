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

/**
 * Versioned payload for what the user pointed at in the embedded preview.
 * Phase 1 ships the schema only. Phase 2 adds viewport PNG to the composer first;
 * structured fields fill in later from DOM capture and regional screenshot.
 */
export const McodeBrowserCaptureV1Schema = lazySchema(() =>
  z.object({
    schemaVersion: z.literal(1),
    pageUrl: z.string(),
    pageTitle: z.string(),
    capturedAt: z.string(),
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
