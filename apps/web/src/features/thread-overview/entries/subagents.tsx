import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { openSubagentsRoster, projectSubagents, SubagentIdentityGlyph } from "@/features/subagents";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";
import { type Thread } from "@/transport";
import { useMemo } from "react";
import { OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

function SubagentsEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const overviewToolCalls = useThreadStore((state) => (
    open ? state.records.get(thread.id)?.toolCalls : undefined
  ));
  const overviewNarrative = useThreadStore((state) => (
    open ? state.records.get(thread.id)?.narrativeByMessage : undefined
  ));
  const subagentRoster = useMemo(
    () => projectSubagents(
      overviewToolCalls,
      overviewNarrative
        ? Object.values(overviewNarrative).map((entry) => entry?.tools)
        : undefined,
    ),
    [overviewNarrative, overviewToolCalls],
  );
  const subagentTotal = subagentRoster.active.length + subagentRoster.finished.length;
  const subagentGlyphRows = [...subagentRoster.active, ...subagentRoster.finished].slice(0, 4);
  const subagentStateCopy = [
    subagentRoster.active.length > 0 ? `${subagentRoster.active.length} active` : null,
    `${subagentRoster.finished.length} done`,
  ].filter(Boolean).join(", ");
  return (<ThreadOverviewWhen when={subagentTotal > 0}>
    <>
      <Separator className="my-1.5" />
      <div className="px-2 pt-1 text-xs font-medium text-muted">
        Subagents
      </div>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        data-testid="thread-overview-subagents"
        onClick={() => openSubagentsRoster()}
        aria-label={`Subagents, ${subagentRoster.active.length} active, ${subagentRoster.finished.length} done`}
        className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start gap-2")}
      >
        <span className="flex -space-x-1" aria-hidden>
          {subagentGlyphRows.map((row) => (
            <SubagentIdentityGlyph
              key={row.id}
              identity={row.identity}
              hasExplicitIdentity={row.hasExplicitIdentity}
              paletteSeed={row.id}
              size={11}
              className="size-4 ring-2 ring-background"
            />
          ))}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {subagentStateCopy}
        </span>
      </Button>
    </>
  </ThreadOverviewWhen>);
}

/** Subagents block in the thread overview, preserving its existing row position. */
export function SubagentsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SubagentsEntry thread={subject.thread} /> : null;
}
