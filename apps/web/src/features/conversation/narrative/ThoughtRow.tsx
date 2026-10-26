import { lazy, memo, Suspense, useCallback, useId, useState } from "react";
import { Brain } from "lucide-react";
import { formatDuration } from "@/lib/time";
import { NarrativeToolRow, type RowExpansion } from "./NarrativeToolRow";
import type { ThoughtSegment } from "./types";

const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));

/** Props for {@link ThoughtRow}. */
export interface ThoughtRowProps {
  /** Reasoning segment shown by this row. */
  segment: ThoughtSegment;
  /** True while the segment can still receive reasoning text. */
  isActive: boolean;
  /** Owner-held open state, so a virtualized row keeps it across unmounts. */
  virtualExpansion?: RowExpansion;
}

interface ThoughtRowHeaderProps {
  startedAt: number;
  endedAt: number | undefined;
  isActive: boolean;
  hasText: boolean;
  open: boolean;
  preview: string;
  onToggle: () => void;
  panelId: string;
}

/**
 * Takes only scalar props so the default shallow memo skips it while reasoning
 * text streams into a collapsed row.
 */
const ThoughtRowHeader = memo(function ThoughtRowHeader({
  startedAt,
  endedAt,
  isActive,
  hasText,
  open,
  preview,
  onToggle,
  panelId,
}: ThoughtRowHeaderProps) {
  return (
    <NarrativeToolRow
      icon={Brain}
      label={thoughtLabel(startedAt, endedAt, isActive)}
      disclosure={hasText ? { open, onToggle, controlsId: open ? panelId : undefined } : undefined}
    >
      {preview ? <span className="min-w-0 text-fade whitespace-nowrap text-sm text-muted">{preview}</span> : null}
    </NarrativeToolRow>
  );
});

function thoughtLabel(startedAt: number, endedAt: number | undefined, isActive: boolean): string {
  if (isActive) return "Thinking";
  if (endedAt === undefined) return "Thought";
  return `Thought for ${formatDuration(Math.max(1, Math.round((endedAt - startedAt) / 1000)))}`;
}

const LEADING_MARKER = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/;
const WRAPPING_EMPHASIS = /^(\*\*|__|\*|_)(.+)\1$/;

function thoughtPreview(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const unmarked = firstLine.trim().replace(LEADING_MARKER, "");
  return unmarked.replace(WRAPPING_EMPHASIS, "$2").trim();
}

function ThoughtRowBody({ text, panelId }: { text: string; panelId: string }) {
  return (
    <div id={panelId} className="scroll-fade-y max-h-[24rem] min-w-0 max-w-full pt-1 pb-2 pl-6 text-sm text-muted">
      <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
        <LazyMarkdownContent content={text} isStreaming={false} />
      </Suspense>
    </div>
  );
}

/**
 * One reasoning segment as a collapsed "Thought" row. The text renders only
 * once the user opens the row, so streaming reasoning costs no markdown work
 * until then.
 */
export function ThoughtRow({ segment, isActive, virtualExpansion }: ThoughtRowProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const toggleLocal = useCallback(() => setLocalOpen((current) => !current), []);
  const panelId = useId();
  const open = virtualExpansion?.open ?? localOpen;
  const hasText = segment.text.trim().length > 0;
  return (
    <div className="min-w-0 max-w-full">
      <ThoughtRowHeader
        startedAt={segment.startedAt}
        endedAt={segment.endedAt}
        isActive={isActive}
        hasText={hasText}
        open={open}
        preview={hasText && !open ? thoughtPreview(segment.text) : ""}
        onToggle={virtualExpansion?.onToggle ?? toggleLocal}
        panelId={panelId}
      />
      {hasText && open ? <ThoughtRowBody text={segment.text} panelId={panelId} /> : null}
    </div>
  );
}
