import { z } from "zod";

/**
 * MIME marker for composer rows that carry only structured browser capture JSON in the
 * outbound fence without a persisted image file.
 */
export const MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME = "application/x-mcode-browser-context";

/** True when attachment metadata denotes a fence-only preview context row (no disk file). */
export function isVirtualBrowserContextAttachment(mimeType: string): boolean {
  return mimeType === MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME;
}

/** Metadata for an image or file attachment. No binary data, just a pointer. */
export const AttachmentMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sourcePath: z.string(),
});
/** Metadata for an image or file attachment including its source path. */
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** Stored attachment metadata (no sourcePath, since files live at a known location). */
export const StoredAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
/** Stored attachment metadata without a source path. */
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;
