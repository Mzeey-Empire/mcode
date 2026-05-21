import { lazy, Suspense, useMemo } from "react";
import { reconstructWithChangeMap } from "@/lib/diff-preview-content";
import type { ParsedDiffLine } from "@/lib/diff-parser";

/**
 * Lazy-loaded inner renderer. Bundles `react-markdown`, `remark-gfm` and
 * our diff-markers plugin into a separate chunk so the diff preview only
 * pulls them in when the user actually clicks Preview.
 */
const PreviewMarkdown = lazy(() => import("./DiffPreviewMarkdown"));

/** Props for {@link DiffPreview}. */
interface DiffPreviewProps {
  /** Pre-parsed diff lines from the parent (avoids re-parsing the raw diff string). */
  lines: ParsedDiffLine[];
}

/**
 * Whole-file Markdown preview with GitHub-style change highlighting.
 *
 * Reconstructs the post-change content from the parsed diff lines and
 * tags each block whose source range contains an added line so the
 * renderer can tint it sage. Removed content is omitted from the preview
 * — the raw diff view shows it.
 */
export function DiffPreview({ lines }: DiffPreviewProps) {
  const { content, addedLines } = useMemo(
    () => reconstructWithChangeMap(lines),
    [lines],
  );

  return (
    <div className="p-4 text-sm leading-relaxed text-foreground/85">
      <Suspense
        fallback={
          <span className="text-muted-foreground text-sm">Loading preview…</span>
        }
      >
        <PreviewMarkdown content={content} addedLines={addedLines} />
      </Suspense>
    </div>
  );
}
