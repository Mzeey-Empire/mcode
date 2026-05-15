import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import type { NarrativeItem, NarrativeCounts } from "./types";
import type { ToolCall } from "@/transport/types";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolSummaryLine } from "./ToolSummaryLine";
import { HookRow } from "./HookRow";
import { SubagentRow } from "./SubagentRow";
import { TurnFooter } from "./TurnFooter";
import { buildPersistedNarrativeItems } from "./build-persisted-narrative";

/** Props for `PersistedNarrative`. */
export interface PersistedNarrativeProps {
  /** Assistant message id (server-side or local) whose narrative to render. */
  messageId: string;
  /**
   * Body of the assistant message. Used by the client-side suffix-match
   * safety net to suppress thought segments that duplicate the message body.
   */
  messageContent?: string;
}

/**
 * Returns the muted-dot class for a persisted item. All rows render as
 * completed (no `animate-pulse`, no primary tint) because the turn is over.
 */
function dotClassForItem(item: NarrativeItem): string {
  switch (item.type) {
    case "hook":
      return item.hook.didBlock
        ? "before:w-[3px] before:h-[3px] before:top-[9px] before:left-[-10px] before:-translate-x-1/2 before:bg-[var(--diff-remove)]"
        : "before:w-[3px] before:h-[3px] before:top-[9px] before:left-[-10px] before:-translate-x-1/2 before:bg-muted-foreground/25";
    case "subagent":
      return item.toolCall.isError
        ? "before:bg-[var(--diff-remove)]"
        : "before:bg-muted-foreground/30";
    default:
      return "before:bg-muted-foreground/30";
  }
}

/** Top-margin class for a persisted row. Mirrors the live `marginClassForItem`. */
function marginClassForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return index === 0 ? "mt-0" : "mt-1.5";
    case "subagent":
      return "mt-1";
    default:
      return "mt-0";
  }
}

/** Stable key for a persisted row. */
function keyForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}-${index}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}-${index}`;
    case "subagent":
      return `subagent-${item.toolCall.id}`;
    default:
      return `item-${index}`;
  }
}

/** Render one persisted narrative row. */
function renderItem(item: NarrativeItem, allToolCalls: readonly ToolCall[]): React.ReactNode {
  switch (item.type) {
    case "thought":
      return <ThoughtBlock segment={item.segment} isActive={false} />;
    case "tool-group":
      return (
        <ToolSummaryLine
          group={item.group}
          hasError={item.hasError}
          hasCancelled={item.hasCancelled}
        />
      );
    case "hook":
      return <HookRow hook={item.hook} />;
    case "subagent":
      return (
        <SubagentRow
          toolCall={item.toolCall}
          children={item.children}
          hooks={item.hooks}
          allToolCalls={allToolCalls}
        />
      );
    default:
      return null;
  }
}

/**
 * Render the persisted narrative timeline for a completed assistant message.
 *
 * Lazy-loads records via `loadNarrativeForMessage` on first mount (eager
 * prefetch in the store covers the recent-message window; this effect catches
 * the older-message lazy path). Returns `null` until records arrive so the
 * layout doesn't jump.
 *
 * Persisted mode differences from live `NarrativeFlow`:
 *   - No `NarrativeIndicator` (the turn is over)
 *   - Always renders `TurnFooter` when there's at least one row
 *   - Sub-agents render via the same `SubagentRow` but lack the "active"
 *     visual treatment (no pulse, no primary tint)
 */
export function PersistedNarrative({ messageId, messageContent }: PersistedNarrativeProps) {
  const records = useThreadStore((s) => s.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (records || triggered.current) return;
    triggered.current = true;
    void load(messageId);
  }, [messageId, records, load]);

  const { items, counts, allToolCalls, durationMs } = useMemo(() => {
    if (!records) {
      return {
        items: [] as NarrativeItem[],
        counts: { steps: 0, thoughts: 0, subagents: 0 } as NarrativeCounts,
        allToolCalls: [] as ToolCall[],
        durationMs: null as number | null,
      };
    }
    const built = buildPersistedNarrativeItems({ ...records, messageContent });
    const topLevel = records.tools.filter((t) => t.parent_tool_call_id == null);
    const subagents = topLevel.filter((t) => t.tool_name === "Agent").length;
    const computedCounts: NarrativeCounts = {
      steps: topLevel.length,
      thoughts: records.thoughts.length,
      subagents,
    };
    const liveTools: ToolCall[] = records.tools.map((r) => ({
      id: r.id,
      toolName: r.tool_name,
      toolInput: {},
      output: r.output_summary || null,
      isError: r.status === "failed",
      isComplete:
        r.status === "completed" || r.status === "failed" || r.status === "cancelled",
      parentToolCallId: r.parent_tool_call_id ?? undefined,
      startedAt: Date.parse(r.started_at) || 0,
    }));
    // Derive duration from the earliest start to the latest completion across
    // tools and thoughts. Null when no boundary is parseable.
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
    for (const th of records.thoughts) {
      const s = Date.parse(th.started_at);
      if (Number.isFinite(s)) starts.push(s);
      if (th.ended_at) {
        const e = Date.parse(th.ended_at);
        if (Number.isFinite(e)) ends.push(e);
      }
    }
    const dur =
      starts.length > 0 && ends.length > 0
        ? Math.max(0, Math.max(...ends) - Math.min(...starts))
        : null;
    return {
      items: built,
      counts: computedCounts,
      allToolCalls: liveTools,
      durationMs: dur,
    };
  }, [records]);

  if (!records) return null;
  if (items.length === 0) return null;

  return (
    <div className="relative">
      <div className="relative flex flex-col pl-5">
        <div
          className="absolute left-[10px] top-3 bottom-3 w-px -translate-x-1/2 bg-border pointer-events-none"
          aria-hidden
        />
        {items.map((item, i) => (
          <div
            key={keyForItem(item, i)}
            className={[
              "relative",
              marginClassForItem(item, i),
              "before:content-[''] before:absolute before:w-1 before:h-1 before:rounded-full before:z-[1]",
              "before:left-[-10px] before:top-[11px] before:-translate-x-1/2",
              dotClassForItem(item),
              "narrative-timeline-row",
            ].join(" ")}
          >
            {renderItem(item, allToolCalls)}
          </div>
        ))}
      </div>
      <TurnFooter counts={counts} durationMs={durationMs} />
    </div>
  );
}
