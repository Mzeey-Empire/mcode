import { useMemo, useRef, useCallback, useState, lazy, Suspense } from "react";
import type { Components } from "react-markdown";
import type { PlanVersion } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { PlanAnnotation } from "./PlanAnnotation";

const PlanMarkdown = lazy(() => import("@/components/chat/MarkdownContent"));

/** Annotation on a section heading. */
export interface PlanComment {
  sectionTitle: string;
  text: string;
}

interface PlanDocumentProps {
  plan: PlanVersion;
  /** Current pending annotations. Managed by parent. */
  comments: PlanComment[];
  /** Called when user adds or updates a comment on a heading. */
  onCommentChange: (sectionTitle: string, text: string) => void;
  /** Called when user discards a comment. */
  onCommentDiscard: (sectionTitle: string) => void;
}

const HEADING_BASE =
  "group/heading scroll-mt-14 cursor-pointer rounded-md px-1.5 -mx-1.5 transition-colors duration-100 hover:bg-selected/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50";

function getHeadingClass(level: number): string {
  const levelClass = { 1: "text-base font-semibold", 2: "text-label font-semibold", 3: "text-label" }[level];
  return cn(HEADING_BASE, levelClass);
}

function PlanHeading({ level, children, commentMap, activeHeading, onHeadingClick, onCommit, onSave, onDiscard }: { level: number; children: React.ReactNode; commentMap: Map<string, string>; activeHeading: string | null; onHeadingClick: (title: string) => void; onCommit: (title: string, value: string) => void; onSave: (title: string, value: string) => void; onDiscard: (title: string) => void }) {
  const text = typeof children === "string" ? children : String(children);
  const key = text.toLowerCase();
  const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
  const hasComment = (commentMap.get(key) ?? "").length > 0;
  const isOpen = activeHeading === key;
  return <>
    <Tag tabIndex={0} aria-expanded={isOpen} aria-label={`${text}. Activate to ${isOpen ? "close" : "add"} a section note.`} className={getHeadingClass(level)} onClick={() => onHeadingClick(text)} onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onHeadingClick(text);
    }}>
      {children}
      {hasComment && <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-primary/70 align-middle" aria-hidden />}
      <span className="ml-2 font-mono text-caption font-normal text-muted/0 transition-colors group-hover/heading:text-muted/50 group-focus-visible/heading:text-muted/50" aria-hidden>+</span>
    </Tag>
    {isOpen && <PlanAnnotation key={`annotation-${key}`} sectionTitle={text} initialValue={commentMap.get(key) ?? ""} onCommit={(value) => onCommit(text, value)} onSave={(value) => onSave(text, value)} onDiscard={() => onDiscard(text)} />}
  </>;
}

/**
 * Renders a plan's markdown content with clickable headings for
 * Canvas-style inline annotation. Reuses {@link MarkdownContent} so
 * Mermaid, Shiki code blocks, GFM tables, and preview links match chat.
 */
export function PlanDocument({
  plan,
  comments,
  onCommentChange,
  onCommentDiscard,
}: PlanDocumentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);

  const commentMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of comments) {
      map.set(c.sectionTitle.toLowerCase(), c.text);
    }
    return map;
  }, [comments]);

  const handleHeadingClick = useCallback(
    (title: string) => {
      const key = title.toLowerCase();
      if (activeHeading === key) {
        setActiveHeading(null);
      } else {
        setActiveHeading(key);
      }
    },
    [activeHeading],
  );

  const handleCommitNote = useCallback(
    (title: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        onCommentChange(title, trimmed);
      } else {
        onCommentDiscard(title);
      }
      // Clicking away stashes the draft and collapses the editor, so the
      // heading reads as annotated (dot) without a lingering open textarea.
      setActiveHeading(null);
    },
    [onCommentChange, onCommentDiscard],
  );

  const handleSaveNote = useCallback(
    (title: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        onCommentChange(title, trimmed);
      } else {
        onCommentDiscard(title);
      }
      setActiveHeading(null);
    },
    [onCommentChange, onCommentDiscard],
  );

  const handleDiscardNote = useCallback(
    (title: string) => {
      onCommentDiscard(title);
      setActiveHeading(null);
    },
    [onCommentDiscard],
  );

  const headingRenderer = useCallback(
    (level: number, children: React.ReactNode) => <PlanHeading level={level} children={children} commentMap={commentMap} activeHeading={activeHeading} onHeadingClick={handleHeadingClick} onCommit={handleCommitNote} onSave={handleSaveNote} onDiscard={handleDiscardNote} />,
    [commentMap, activeHeading, handleHeadingClick, handleCommitNote, handleSaveNote, handleDiscardNote],
  );

  const componentOverrides = useMemo<Partial<Components>>(
    () => ({
      h1: ({ children }) => headingRenderer(1, children),
      h2: ({ children }) => headingRenderer(2, children),
      h3: ({ children }) => headingRenderer(3, children),
    }),
    [headingRenderer],
  );

  return (
    <div ref={containerRef} className="min-w-0 overflow-x-hidden px-4 pb-8 pt-4">
      <article
        className={cn(
          "prose prose-sm prose-invert max-w-none min-w-0",
          "[&>h2]:mt-6 [&>h2]:mb-2",
          "[&>h3]:mt-4 [&>h3]:mb-2",
          "[&>p]:max-w-[62ch] [&>p]:text-body-small [&>p]:leading-[1.75] [&>p]:text-muted",
          "[&>ul]:text-body-small [&>ul]:leading-[1.7] [&>li]:text-body-small",
          "[&>ol]:text-body-small [&>ol]:leading-[1.7]",
        )}
      >
        <Suspense fallback={<span className="text-sm text-muted">Loading plan…</span>}>
          <PlanMarkdown content={plan.contentMd} componentOverrides={componentOverrides} />
        </Suspense>
      </article>
    </div>
  );
}
