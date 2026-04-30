import { useMemo, lazy, Suspense } from "react";
import { reconstructNewContent, type ParsedDiffLine } from "@/lib/diff-parser";

const PreviewMarkdown = lazy(() => import("@/components/chat/MarkdownContent"));

/** Props for {@link DiffPreview}. */
interface DiffPreviewProps {
  /** Pre-parsed diff lines from the parent (avoids re-parsing the raw diff string). */
  lines: ParsedDiffLine[];
}

/**
 * Renders a markdown preview of the new (post-change) file content reconstructed
 * from parsed diff lines. Reuses the existing {@link MarkdownContent} renderer so
 * GFM tables, headings, code blocks, and Mermaid diagrams all work out of the box.
 */
export function DiffPreview({ lines }: DiffPreviewProps) {
  const markdown = useMemo(() => reconstructNewContent(lines), [lines]);

  return (
    <div className="p-4 text-sm leading-relaxed text-foreground/80">
      <Suspense fallback={<span className="text-muted-foreground text-sm">Loading preview…</span>}>
        <PreviewMarkdown content={markdown} />
      </Suspense>
    </div>
  );
}
