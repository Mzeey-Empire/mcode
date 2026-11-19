import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { Button } from "@/components/ui/button";
import { ProviderDiscStack } from "@/components/ui/provider-icon";
import { openSubagentsPanel } from "@/features/subagents";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { cn } from "@/lib/utils";
import { rosterOf, useSubagentRosterStore, type RosterLoad } from "@/features/subagents/state/subagentRosterStore";
import { subagentOverviewCounts } from "@/features/subagents/subagent-status";
import { type Thread } from "@/transport";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import { Layers } from "lucide-react";

type SubagentsSummary = readonly [
  kind: RosterLoad["kind"], needsYou: number, running: number, failed: number, finished: number, ...providers: string[],
];

// A flat tuple of primitives so a roster push that changes nothing visible here
// does not re-render the row.
function subagentsSummary(load: RosterLoad | undefined): SubagentsSummary {
  const entries = rosterOf(load)?.entries ?? [];
  const { needsYou, running, failed, finished } = subagentOverviewCounts(entries);
  return [load?.kind ?? "loading", needsYou, running, failed, finished, ...entries.slice(0, 3).map((entry) => entry.provider)];
}

function countsCopy(needsYou: number, running: number, failed: number, finished: number): string {
  return [
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : null,
    running > 0 ? `${running} running` : null,
    failed > 0 ? `${failed} failed` : null,
    finished > 0 ? `${finished} finished` : null,
  ].filter((part) => part !== null).join(" · ");
}

function summaryCopy(kind: RosterLoad["kind"], counts: string): string {
  if (kind === "failed") return "Could not load";
  if (kind === "stale") return counts ? `${counts} · may be out of date` : "May be out of date";
  return counts;
}

function SubagentsEntry({ thread }: { thread: Thread }) {
  const [kind, needsYou, running, failed, finished, ...providers] = useSubagentRosterStore(
    useShallow((state) => subagentsSummary(state.loads.get(thread.id))),
  );
  useEffect(() => { void useSubagentRosterStore.getState().ensure(thread.id); }, [thread.id]);
  const copy = summaryCopy(kind, countsCopy(needsYou, running, failed, finished));
  // Keep failed loads openable so the user can retry even when there are no entries.
  const visible = kind === "failed" || kind === "stale" || needsYou + running + failed + finished > 0;
  return (<ThreadOverviewWhen when={visible}>
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="thread-overview-subagents"
      onClick={() => openSubagentsPanel()}
      aria-label={`Subagents, ${copy}`}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between gap-2")}
    >
      <OverviewRowIcon>
        <Layers />
      </OverviewRowIcon>
      <span className="text-fade min-w-0 grow font-medium text-ink">Subagents</span>
      <ProviderDiscStack providers={providers} />
      <span className="shrink-0 text-caption tabular-nums text-muted">{copy}</span>
    </Button>
  </ThreadOverviewWhen>);
}

/** Subagents block in the thread overview, preserving its existing row position. */
export function SubagentsEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <SubagentsEntry thread={subject.thread} /> : null;
}
