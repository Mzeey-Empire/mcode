import { useMemo, useRef, useCallback } from "react";
import type { PlanRecord, PlanSection } from "@mcode/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PlanDocumentProps {
  plan: PlanRecord;
}

/**
 * Renders a plan's markdown content with section IDs for navigation.
 * Reconstructs section-level IDs from sectionsJson so a future TOC can
 * scroll to specific headings via element.scrollIntoView().
 */
export function PlanDocument({ plan }: PlanDocumentProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const sectionMap = useMemo(() => {
    if (!plan.sectionsJson) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const s of plan.sectionsJson as PlanSection[]) {
      map.set(s.title.toLowerCase(), s.id);
    }
    return map;
  }, [plan.sectionsJson]);

  const headingRenderer = useCallback(
    ({ level, children }: { level: number; children: React.ReactNode }) => {
      const text = typeof children === "string" ? children : String(children);
      const sectionId = sectionMap.get(text.toLowerCase());
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      return (
        <Tag id={sectionId ?? undefined} className="scroll-mt-12">
          {children}
        </Tag>
      );
    },
    [sectionMap],
  );

  return (
    <div ref={containerRef} className="px-6 pb-8 pt-4">
      <article className="prose prose-sm prose-invert max-w-none [&>h2]:mt-6 [&>h2]:mb-2 [&>h2]:text-[13.5px] [&>h2]:font-semibold [&>h3]:mt-4 [&>h3]:mb-2 [&>h3]:text-[13px] [&>h3]:font-medium [&>p]:text-[13px] [&>p]:leading-[1.7] [&>p]:text-muted-foreground [&>p]:max-w-[62ch] [&>ul]:text-[13px] [&>li]:text-[13px] [&>pre]:bg-card [&>pre]:rounded-md">
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
