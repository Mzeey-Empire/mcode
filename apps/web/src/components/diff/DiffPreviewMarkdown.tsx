import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeRemarkDiffMarkers } from "@/lib/remark-diff-markers";

/** Props for the inner Markdown renderer used by DiffPreview. */
interface DiffPreviewMarkdownProps {
  /** Reconstructed file content (markdown source). */
  readonly content: string;
  /** 1-based line numbers within `content` that were added by this diff. */
  readonly addedLines: ReadonlySet<number>;
}

/**
 * The actual diff-aware Markdown renderer. Kept in a separate module so
 * DiffPreview can lazy-load it — the react-markdown + remark-gfm + plugin
 * surface is meaningful weight to defer until the user opens Preview.
 *
 * Highlighting is delivered as `[data-diff-added]` attributes set by the
 * remark plugin; Tailwind arbitrary selectors style any descendant that
 * carries the attribute. We deliberately don't override per-tag
 * components — letting react-markdown render defaults keeps the surface
 * minimal and avoids competing with the global Markdown styles.
 */
export default function DiffPreviewMarkdown({
  content,
  addedLines,
}: DiffPreviewMarkdownProps) {
  // Memoise the plugin list so we don't reinstantiate the closures every
  // render — only when the added-lines identity changes.
  const remarkPlugins = useMemo(
    () => [remarkGfm, makeRemarkDiffMarkers(addedLines)],
    [addedLines],
  );

  return (
    <div
      className={[
        // Typography baseline. We can't use the chat's prose stack here —
        // we need finer control over how the diff highlight interacts with
        // block margins.
        "space-y-3 break-words",
        // Diff-added block treatment: sage tint, full-bleed within the
        // padded preview container, subtle radius. The negative inline
        // margins make the highlight bleed past the surrounding paragraph
        // indent so it reads as a touched block.
        "[&_[data-diff-added]]:bg-[var(--diff-add-bg)]",
        "[&_[data-diff-added]]:-mx-2 [&_[data-diff-added]]:px-2",
        "[&_[data-diff-added]]:py-0.5 [&_[data-diff-added]]:rounded-sm",
        // Basic typographic defaults for unstyled tags.
        "[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4",
        "[&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3",
        "[&_p]:leading-relaxed",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:font-mono",
        "[&_pre]:rounded [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:font-mono [&_pre]:overflow-x-auto",
        // Blockquote: indented italic with a faint bg tint instead of a
        // left stripe (border-l > 1px is banned per impeccable).
        "[&_blockquote]:bg-muted/15 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:rounded-sm",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_hr]:my-4 [&_hr]:border-border/40",
        "[&_table]:border-collapse [&_table]:my-2",
        "[&_th]:border [&_th]:border-border/40 [&_th]:px-2 [&_th]:py-1",
        "[&_td]:border [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1",
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins}>{content}</ReactMarkdown>
    </div>
  );
}
