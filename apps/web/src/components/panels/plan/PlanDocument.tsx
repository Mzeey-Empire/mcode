import { useMemo, useRef, useCallback, useState } from "react";
import type { PlanRecord, PlanSectionNav } from "@mcode/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PlanAnnotation } from "./PlanAnnotation";

/** Annotation on a section heading. */
export interface PlanComment {
  sectionTitle: string;
  text: string;
}

interface PlanDocumentProps {
  plan: PlanRecord;
  /** Current pending annotations. Managed by parent. */
  comments: PlanComment[];
  /** Called when user adds or updates a comment on a heading. */
  onCommentChange: (sectionTitle: string, text: string) => void;
  /** Called when user discards a comment. */
  onCommentDiscard: (sectionTitle: string) => void;
}

/**
 * Renders a plan's markdown content with clickable headings for
 * Canvas-style inline annotation. Clicking a heading opens (or
 * focuses) an annotation textarea below it.
 */
export function PlanDocument({
  plan,
  comments,
  onCommentChange,
  onCommentDiscard,
}: PlanDocumentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);

  const sectionMap = useMemo(() => {
    if (!plan.sectionsJson) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const s of plan.sectionsJson as PlanSectionNav[]) {
      map.set(s.title.toLowerCase(), s.id);
    }
    return map;
  }, [plan.sectionsJson]);

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
        // If no comment exists yet, create an empty one to show the textarea
        if (!commentMap.has(key)) {
          onCommentChange(title, "");
        }
      }
    },
    [activeHeading, commentMap, onCommentChange],
  );

  const headingRenderer = useCallback(
    ({ level, children }: { level: number; children: React.ReactNode }) => {
      const text = typeof children === "string" ? children : String(children);
      const key = text.toLowerCase();
      const sectionId = sectionMap.get(key);
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      const hasComment = commentMap.has(key) && (commentMap.get(key) ?? "").length > 0;
      const isOpen = activeHeading === key;

      return (
        <>
          <Tag
            id={sectionId ?? undefined}
            className="group/heading scroll-mt-12 cursor-pointer rounded px-1.5 -mx-1.5 transition-colors duration-100 hover:bg-accent/60"
            onClick={() => handleHeadingClick(text)}
          >
            {children}
            {hasComment && (
              <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-primary/70 align-middle" />
            )}
            <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground/0 transition-colors group-hover/heading:text-muted-foreground/40">
              +
            </span>
          </Tag>
          {isOpen && (
            <PlanAnnotation
              key={`annotation-${key}`}
              sectionTitle={text}
              initialValue={commentMap.get(key) ?? ""}
              onCommit={(val) => onCommentChange(text, val)}
              onDiscard={() => {
                onCommentDiscard(text);
                setActiveHeading(null);
              }}
            />
          )}
        </>
      );
    },
    [sectionMap, commentMap, activeHeading, handleHeadingClick, onCommentChange, onCommentDiscard],
  );

  return (
    <div ref={containerRef} className="px-6 pb-8 pt-4">
      <article className="prose prose-sm prose-invert max-w-none [&>h2]:mt-6 [&>h2]:mb-2 [&>h2]:text-[13.5px] [&>h2]:font-semibold [&>h3]:mt-4 [&>h3]:mb-2 [&>h3]:text-[13px] [&>h3]:font-medium [&>p]:text-[13px] [&>p]:leading-[1.7] [&>p]:text-muted-foreground [&>p]:max-w-[62ch] [&>ul]:text-[13px] [&>li]:text-[13px] [&>pre]:bg-card [&>pre]:rounded-md [&>table]:text-[12.5px] [&>table]:border-collapse [&_th]:border [&_th]:border-border/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border/50 [&_td]:px-3 [&_td]:py-1.5">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => headingRenderer({ level: 1, children }),
            h2: ({ children }) => headingRenderer({ level: 2, children }),
            h3: ({ children }) => headingRenderer({ level: 3, children }),
          }}
        >
          {plan.contentMd}
        </ReactMarkdown>
      </article>
    </div>
  );
}
