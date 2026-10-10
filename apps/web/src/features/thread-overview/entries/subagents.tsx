import { Button } from "@/components/ui/button";
import { ProviderDiscStack } from "@/components/ui/provider-icon";
import { openSubagentsRoster } from "@/features/subagents";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { cn } from "@/lib/utils";
import { useSubagentRoster } from "@/features/subagents/state/subagentRosterStore";
import { subagentOverviewCounts } from "@/features/subagents/subagent-status";
import { type Thread } from "@/transport";
import { OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

function SubagentsEntry({ thread }: { thread: Thread }) {
  const roster = useSubagentRoster(thread.id);
  const counts = subagentOverviewCounts(roster?.entries ?? []);
  const subagentTotal = counts.active + counts.done;
  const subagentProviders = roster?.entries.map((entry) => entry.provider) ?? [];
  const subagentStateCopy = [
    counts.active > 0 ? `${counts.active} active` : null,
    `${counts.done} done`,
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
        aria-label={`Subagents, ${counts.active} active, ${counts.done} done`}
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
