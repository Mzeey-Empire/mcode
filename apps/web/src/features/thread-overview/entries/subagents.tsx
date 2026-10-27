import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import type { SubagentRoster } from "@mcode/contracts/models/subagent-roster";
import { Button } from "@/components/ui/button";
import { ProviderDiscStack } from "@/components/ui/provider-icon";
import { openSubagentsPanel } from "@/features/subagents";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { cn } from "@/lib/utils";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { subagentOverviewCounts } from "@/features/subagents/subagent-status";
import { type Thread } from "@/transport";
import { OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

type SubagentsSummary = readonly [active: number, done: number, ...providers: string[]];

// A flat tuple of primitives so a roster push that changes nothing visible here
// does not re-render the row.
function subagentsSummary(roster: SubagentRoster | undefined): SubagentsSummary {
  const entries = roster?.entries ?? [];
  const { active, done } = subagentOverviewCounts(entries);
  return [active, done, ...entries.slice(0, 3).map((entry) => entry.provider)];
}

function SubagentsEntry({ thread }: { thread: Thread }) {
  const [active, done, ...providers] = useSubagentRosterStore(
    useShallow((state) => subagentsSummary(state.rosters.get(thread.id))),
  );
  useEffect(() => { void useSubagentRosterStore.getState().ensure(thread.id); }, [thread.id]);
  const copy = active > 0 ? `${active} active · ${done} done` : `${done} done`;
  return (<ThreadOverviewWhen when={active + done > 0}>
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="thread-overview-subagents"
      onClick={() => openSubagentsPanel()}
      aria-label={`Subagents, ${active} active, ${done} done`}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start gap-2")}
    >
      <ProviderDiscStack providers={providers} />
      <span className="shrink-0 tabular-nums text-muted">{copy}</span>
    </Button>
  </ThreadOverviewWhen>);
}

/** Subagents block in the thread overview, preserving its existing row position. */
export function SubagentsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SubagentsEntry thread={subject.thread} /> : null;
}
