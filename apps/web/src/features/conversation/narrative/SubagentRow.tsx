import { useSubagentRoster } from "@/features/subagents/state/subagentRosterStore";
import { subagentChipStatus, subagentOverviewCounts } from "@/features/subagents/subagent-status";
import { formatSubagentDisplayName } from "@mcode/contracts/models/tool-call-record";
import { isLiveSubagentStatus, type SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { cn } from "@/lib/utils";
import type { ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import { useSubagentThreadId } from "./subagent-provider";
import type { SubagentActivity, SubagentRosterTarget } from "./types";

interface SubagentRowProps {
  participants: readonly ToolCall[];
  /** Opens the selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Contiguous sibling Agent calls sharing one parent timeline unit. */
  activities?: readonly SubagentActivity[];
}

/**
 * One chip's view. Until the roster has an entry for the call, the chip only
 * knows the call's own title: no provider, no status, nothing to open.
 */
type SubagentChipView =
  | { kind: "pending"; key: string; title: string }
  | { kind: "resolved"; key: string; title: string; entry: SubagentRosterEntry };

const VISIBLE_CHIPS = 2;

function remainingLabel(entries: readonly SubagentRosterEntry[]): string {
  const { active, done } = subagentOverviewCounts(entries);
  return [active > 0 ? `+${active} working` : "", done > 0 ? `${active > 0 ? "" : "+"}${done} finished` : ""].filter(Boolean).join(", ");
}

function entryForCall(entries: readonly SubagentRosterEntry[], call: ToolCall): SubagentRosterEntry | undefined {
  return entries.find((entry) => entry.sourceToolCallId === call.id)
    ?? entries.find((entry) => entry.sourceToolCallId === call.parentToolCallId);
}

function participantTitle(participant: ToolCall): string {
  const task = participant.subagentPresentation?.task;
  return task ? formatSubagentDisplayName(task) : participant.subagentPresentation?.displayName ?? "Subagent";
}

function subagentChipView(participant: ToolCall, entry: SubagentRosterEntry | undefined): SubagentChipView {
  return entry
    ? { kind: "resolved", key: participant.id, title: entry.title, entry }
    : { kind: "pending", key: participant.id, title: participantTitle(participant) };
}

function chipParticipants(participants: readonly ToolCall[], grouped: readonly SubagentActivity[] | undefined): readonly ToolCall[] {
  return grouped
    ? grouped.map((activity) => activity.participants.at(-1) ?? activity.toolCall)
    : participants;
}

function SubagentChip({ view, onSubagentSelect }: { view: SubagentChipView; onSubagentSelect: SubagentRowProps["onSubagentSelect"] }) {
  const entry = view.kind === "resolved" ? view.entry : undefined;
  const word = entry ? subagentChipStatus(entry.status) : "";
  const statusId = `subagent-status-${view.key}`;
  return (
    <span className="flex min-w-0 shrink">
      <Button
        type="button"
        variant="ghost"
        size="compact"
        disabled={!entry}
        onClick={() => entry && onSubagentSelect?.(entry.id, isLiveSubagentStatus(entry.status) ? "active" : "finished")}
        aria-label={`${entry ? "Open" : "Show"} ${view.title} subagent details`}
        aria-describedby={statusId}
        className="h-7 min-w-0 shrink justify-start gap-1.5 rounded-full border-border pr-2.5 pl-1.5 text-left text-xs disabled:opacity-100 hover:bg-hover/30 motion-reduce:transition-none"
      >
        {entry && (
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
            <ProviderIcon provider={entry.provider} size={16} />
          </span>
        )}
        <span className="min-w-0 text-fade font-medium text-ink">{view.title}</span>
        {entry && (
          <span aria-hidden className={cn("shrink-0", entry.status === "failed" ? "text-error" : "text-muted")}>
            {word}
          </span>
        )}
      </Button>
      <span id={statusId} role="status" className="sr-only">{word}</span>
    </span>
  );
}

function OverflowChip({ entries, onOpenSubagents }: { entries: readonly SubagentRosterEntry[]; onOpenSubagents: SubagentRowProps["onOpenSubagents"] }) {
  const label = remainingLabel(entries);
  if (!label) return null;
  const target: SubagentRosterTarget = entries.some((entry) => isLiveSubagentStatus(entry.status)) ? "active" : "finished";
  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      onClick={() => onOpenSubagents?.(target)}
      className="h-7 rounded-full border-border px-2.5 text-xs text-muted hover:bg-hover/30"
      aria-label={`Open full Subagents roster, ${label}`}
    >
      {label}
    </Button>
  );
}

/** Renders a turn's subagents as provider chips whose words come from the thread's roster. */
export function SubagentRow({
  participants,
  onSubagentSelect,
  onOpenSubagents,
  activities,
}: SubagentRowProps) {
  const entries = useSubagentRoster(useSubagentThreadId())?.entries ?? [];
  const grouped = activities && activities.length > 1 ? activities : undefined;
  const chips = chipParticipants(participants, grouped)
    .slice(0, VISIBLE_CHIPS)
    .map((participant) => subagentChipView(participant, entryForCall(entries, participant)));
  const remainingEntries = (grouped?.slice(VISIBLE_CHIPS) ?? []).flatMap((activity) => {
    const entry = entryForCall(entries, activity.toolCall);
    return entry ? [entry] : [];
  });

  return (
    <div className={NARRATIVE_TOOL_ROW}>
      {chips.map((view) => (
        <SubagentChip key={view.key} view={view} onSubagentSelect={onSubagentSelect} />
      ))}
      <OverflowChip entries={remainingEntries} onOpenSubagents={onOpenSubagents} />
    </div>
  );
}
