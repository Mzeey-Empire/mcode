/**
 * Shared attachment labeling and MIME grouping for chat attachment UI.
 */

/** Human-readable byte size for attachment labels (B, KB, MB). */
export function formatAttachmentByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Buckets for icon tinting; PDF is included for consistent tile chrome without a preview pane. */
export type AttachmentIconKind = "pdf" | "office" | "generic";

/**
 * Maps a MIME type to an {@link AttachmentIconKind} for predictable tile icons.
 */
export function attachmentIconKindFromMime(mimeType: string): AttachmentIconKind {
  if (mimeType === "application/pdf") return "pdf";
  const isOffice =
    mimeType.includes("officedocument") ||
    mimeType.includes("opendocument") ||
    mimeType === "application/rtf" ||
    mimeType === "text/rtf";
  if (isOffice) return "office";
  return "generic";
}
