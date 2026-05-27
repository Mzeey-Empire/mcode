import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { TurnFooter } from "./TurnFooter";
import type { NarrativeCounts } from "./types";

/** Props for {@link PersistedTurnFooter}. */
export interface PersistedTurnFooterProps {
  /** Assistant message id this footer belongs to. */
  messageId: string;
}

/**
 * Compact step / sub-agent / duration summary rendered AFTER the assistant
 * message body to close out a completed turn.
 *
 * The earlier design placed the footer between the persisted narrative
 * timeline and the message bubble — that separated the agent's actions from
 * the answer they led to. Putting the footer at the end keeps the reading
 * order: actions → response → wrap-up.
 *
 * Lazy-loads the same narrative records as `PersistedNarrative` via the
 * threadStore cache. Returns `null` until records arrive so the layout does
 * not jump.
 */
export function PersistedTurnFooter({ messageId }: PersistedTurnFooterProps) {
  const records = useThreadStore((s) => s.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (records || triggered.current) return;
    triggered.current = true;
    void load(messageId);
  }, [messageId, records, load]);

  const summary = useMemo(() => {
    if (!records) return null;
    const topLevel = records.tools.filter((t) => t.parent_tool_call_id == null);
    const counts: NarrativeCounts = {
      steps: topLevel.length,
      narrationSegments: records.narrationSegments.length,
      subagents: topLevel.filter((t) => t.tool_name === "Agent").length,
    };
    // Derive duration from the earliest start to the latest completion across
    // tools and narration segments. Null when no boundary is parseable.
    const starts: number[] = [];
    const ends: number[] = [];
    for (const t of records.tools) {
      const s = Date.parse(t.started_at);
      if (Number.isFinite(s)) starts.push(s);
      if (t.completed_at) {
        const e = Date.parse(t.completed_at);
        if (Number.isFinite(e)) ends.push(e);
      }
    }
    for (const seg of records.narrationSegments) {
      const s = Date.parse(seg.started_at);
      if (Number.isFinite(s)) starts.push(s);
      if (seg.ended_at) {
        const e = Date.parse(seg.ended_at);
        if (Number.isFinite(e)) ends.push(e);
      }
    }
    const durationMs =
      starts.length > 0 && ends.length > 0
        ? Math.max(0, Math.max(...ends) - Math.min(...starts))
        : null;
    return { counts, durationMs };
  }, [records]);

  if (!records || !summary) return null;
  // Suppress entirely when the turn had zero structured activity.
  if (summary.counts.steps === 0 && summary.counts.subagents === 0) return null;

  return <TurnFooter counts={summary.counts} durationMs={summary.durationMs} />;
}
