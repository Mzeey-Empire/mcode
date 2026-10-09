import { Button } from "@/components/ui/button";
import { ProviderDiscStack } from "@/components/ui/provider-icon";
import { openSubagentsRoster, projectSubagents } from "@/features/subagents";
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
  // Subagent threads are provider-native, so every subagent shows the thread's provider.
  const subagentProviders = useMemo(
    () => Array.from({ length: subagentTotal }, () => thread.provider),
    [subagentTotal, thread.provider],
  );
  const subagentStateCopy = [
    subagentRoster.active.length > 0 ? `${subagentRoster.active.length} active` : null,
    `${subagentRoster.finished.length} done`,
  ].filter(Boolean).join(", ");
  return (<ThreadOverviewWhen when={subagentTotal > 0}>
    <>
      <div className="px-2 pt-1 text-xs font-medium text-muted">
        Subagents
      </div>
      <Button
        variant="ghost"
        size="compact"
        type="button"
        data-testid="thread-overview-subagents"
        onClick={() => openSubagentsRoster()}
        aria-label={`Subagents, ${subagentRoster.active.length} active, ${subagentRoster.finished.length} done`}
        className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start gap-2")}
      >
        <ProviderDiscStack providers={subagentProviders} />
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
