import { useSubagentRoster } from "@/features/subagents/state/subagentRosterStore";
import { subagentChipStatus, subagentOverviewCounts } from "@/features/subagents/subagent-status";
import { useState } from "react";
import { formatSubagentDisplayName, type SubagentRosterEntry } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import type { HookExecution, ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import type { SubagentLifecycle } from "./subagent-lifecycle";
import { useSubagentThreadId } from "./subagent-provider";
import type { SubagentActivity, SubagentRosterTarget } from "./types";

interface SubagentRowProps {
  toolCall: ToolCall;
  participants: readonly ToolCall[];
  lifecycle: SubagentLifecycle;
  /** Direct children retained by the narrative builder but hidden from chat. */
  children: readonly ToolCall[];
  hooks: readonly HookExecution[];
  /** Full turn graph retained for detail projection. */
  allToolCalls?: readonly ToolCall[];
  /** Nested depth retained for the shared narrative contract. */
  depth?: number;
  /** Opens the selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Contiguous sibling Agent calls sharing one parent timeline unit. */
  activities?: readonly SubagentActivity[];
}

interface VisibleSubagentParticipant {
  participant: ToolCall;
  lifecycle: SubagentLifecycle;
}

interface SubagentParticipantView {
  title: string;
  detailTarget: string | undefined;
  hasDetailTarget: boolean;
  status: string;
  unavailableMessage: string;
}

interface SubagentParticipantProps extends VisibleSubagentParticipant {
  unavailableDetailId: string | undefined;
  onSubagentSelect: SubagentRowProps["onSubagentSelect"];
  onUnavailableDetail: (id: string) => void;
}

interface AggregateSubagentButtonProps {
  label: string;
  target: SubagentRosterTarget;
  onOpenSubagents: SubagentRowProps["onOpenSubagents"];
}

function remainingLabel(entries: readonly SubagentRosterEntry[]): string {
  const { active, done } = subagentOverviewCounts(entries);
  return [active > 0 ? `+${active} working` : "", done > 0 ? `${active > 0 ? "" : "+"}${done} finished` : ""].filter(Boolean).join(", ");
}

function transcriptUnavailableMessage(providerName: string | undefined): string {
  return providerName
    ? `${providerName} did not provide this subagent’s transcript.`
    : "This provider did not provide this subagent’s transcript.";
}

function groupedSubagentActivities(
  activities: readonly SubagentActivity[] | undefined,
): readonly SubagentActivity[] | undefined {
  if (!activities || activities.length <= 1) return undefined;
  return activities;
}

function visibleSubagentParticipants(
  groupedActivities: readonly SubagentActivity[] | undefined,
  participants: readonly ToolCall[],
  lifecycle: SubagentLifecycle,
): VisibleSubagentParticipant[] {
  if (groupedActivities) {
    return groupedActivities.slice(0, 2).map((activity) => ({
      participant: activity.participants.at(-1) ?? activity.toolCall,
      lifecycle: activity.lifecycle,
    }));
  }
  return participants.slice(0, 2).map((participant) => ({ participant, lifecycle }));
}

function participantTranscriptUnavailableMessage(participant: ToolCall): string {
  const detail = participant.subagentPresentation?.detail;
  return transcriptUnavailableMessage(
    detail?.kind === "transcript-unavailable" ? detail.providerName : undefined,
  );
}

function participantIdentity(participant: ToolCall): string {
  return participant.subagentPresentation?.displayName ?? "Subagent";
}

function participantTitle(participant: ToolCall): string {
  const task = participant.subagentPresentation?.task;
  return task ? formatSubagentDisplayName(task) : participantIdentity(participant);
}

function projectSubagentParticipant(participant: ToolCall, entry: SubagentRosterEntry | undefined): SubagentParticipantView {
  return {
    title: entry?.title ?? participantTitle(participant),
    detailTarget: entry?.id,
    hasDetailTarget: entry !== undefined,
    status: entry ? subagentChipStatus(entry.status) : "",
    unavailableMessage: participantTranscriptUnavailableMessage(participant),
  };
}

function entryForParticipant(entries: readonly SubagentRosterEntry[], participant: ToolCall): SubagentRosterEntry | undefined {
  return entries.find((entry) => entry.sourceToolCallId === participant.id)
    ?? entries.find((entry) => entry.sourceToolCallId === participant.parentToolCallId);
}

function handleSubagentSelection(
  participant: ToolCall,
  lifecycle: SubagentLifecycle,
  detailTarget: string | undefined,
  onSubagentSelect: SubagentRowProps["onSubagentSelect"],
  onUnavailableDetail: (id: string) => void,
): void {
  if (!detailTarget) {
    onUnavailableDetail(participant.id);
    return;
  }
  onSubagentSelect?.(
    detailTarget,
    lifecycle === "finished" ? "finished" : "active",
  );
}

function SubagentTranscriptNotice({
  participantId,
  unavailableDetailId,
  message,
}: {
  participantId: string;
  unavailableDetailId: string | undefined;
  message: string;
}) {
  if (unavailableDetailId !== participantId || !message) return null;

  return (
    <span data-testid="subagent-transcript-unavailable" role="status" className="text-xs text-muted">
      {message}
    </span>
  );
}

function SubagentParticipant({
  participant,
  unavailableDetailId,
  onSubagentSelect,
  onUnavailableDetail,
}: SubagentParticipantProps) {
  const roster = useSubagentRoster(useSubagentThreadId());
  const entry = entryForParticipant(roster?.entries ?? [], participant);
  const view = projectSubagentParticipant(participant, entry);
  const provider = entry?.provider ?? "";

  return (
    <span className="flex min-w-0 shrink items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="compact"
        onClick={() => handleSubagentSelection(
          participant,
          entry?.status === "running" ? "started" : "finished",
          view.detailTarget,
          onSubagentSelect,
          onUnavailableDetail,
        )}
        className="min-w-0 shrink gap-1 rounded-full px-2 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-hover/30"
        aria-label={`${view.hasDetailTarget ? "Open" : "Show"} ${view.title} subagent details`}
        disabled={!entry}
        aria-describedby={`subagent-status-${participant.id}`}
      >
        <ProviderIcon provider={provider} size={16} />
        <span className="min-w-0 text-fade text-xs font-medium text-ink/85">
          {view.title}
        </span>
      </Button>
      <span id={`subagent-status-${participant.id}`} role="status" className="sr-only">
        {view.status}
      </span>
      <SubagentTranscriptNotice
        participantId={participant.id}
        unavailableDetailId={unavailableDetailId}
        message={view.unavailableMessage}
      />
      <span className="shrink-0 text-xs text-muted">
        {view.status}
      </span>
    </span>
  );
}

function AggregateSubagentButton({
  label,
  target,
  onOpenSubagents,
}: AggregateSubagentButtonProps) {
  if (!label) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      onClick={() => onOpenSubagents?.(target)}
      className="shrink-0 justify-start rounded-full px-2 text-left text-xs text-muted hover:bg-hover/30"
      aria-label={`Open full Subagents roster, ${label}`}
    >
      <span className="whitespace-nowrap">{label}</span>
    </Button>
  );
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({
  participants,
  lifecycle,
  onSubagentSelect,
  onOpenSubagents,
  activities,
}: SubagentRowProps) {
  const [unavailableDetailId, setUnavailableDetailId] = useState<string>();
  const groupedActivities = groupedSubagentActivities(activities);
  const visibleParticipants = visibleSubagentParticipants(
    groupedActivities,
    participants,
    lifecycle,
  );
  const remainingActivities = groupedActivities?.slice(2) ?? [];
  const roster = useSubagentRoster(useSubagentThreadId());
  const remainingEntries = remainingActivities.flatMap((activity) => {
    const entry = entryForParticipant(roster?.entries ?? [], activity.toolCall);
    return entry ? [entry] : [];
  });
  const aggregateLabel = remainingLabel(remainingEntries);
  const aggregateTarget = remainingEntries.some((entry) => entry.status === "running") ? "active" : "finished";

  return (
    <div className={`${NARRATIVE_TOOL_ROW} min-w-0 gap-2`}>
      <div className={`flex min-w-0 flex-1 items-center overflow-hidden ${groupedActivities ? "gap-1" : "gap-2"}`}>
        {visibleParticipants.map(({ participant, lifecycle: participantLifecycle }) => (
          <SubagentParticipant
            key={participant.id}
            participant={participant}
            lifecycle={participantLifecycle}
            unavailableDetailId={unavailableDetailId}
            onSubagentSelect={onSubagentSelect}
            onUnavailableDetail={setUnavailableDetailId}
          />
        ))}
      </div>
      <AggregateSubagentButton
        label={aggregateLabel}
        target={aggregateTarget}
        onOpenSubagents={onOpenSubagents}
      />
    </div>
  );
}
