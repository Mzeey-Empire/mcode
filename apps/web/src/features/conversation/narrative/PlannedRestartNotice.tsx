import { memo, useCallback, useId, useMemo, useState } from "react";
import { Bot, CircleAlert, SquareTerminal, Zap } from "lucide-react";
import { isPlannedRestartFailure } from "@mcode/shared/planned-restart";
import type { Message } from "@/transport";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { ThreadRecord } from "@/stores/thread-record";
import { NarrativeToolRow, NarrativeToolRowDetail, NarrativeToolRowMeta } from "./NarrativeToolRow";
import { TimelineNote } from "./TimelineNote";
import { createPlannedRestartStoppedCallsSelector, type StoppedBackgroundCall } from "./planned-restart-stopped-calls";

const KIND_LABEL: Record<StoppedBackgroundCall["kind"], string> = { subagent: "Subagent", command: "Command" };

/** Bounds the rows one wake lists; the summary and the trailing line still state the true total. */
const MAX_LISTED_CALLS = 20;

function stoppedSummary(count: number): string {
  return count === 1 ? "1 background task stopped" : `${count} background tasks stopped`;
}

function StoppedCallRow({ call }: { call: StoppedBackgroundCall }) {
  return (
    <li className="min-w-0 max-w-full">
      <NarrativeToolRow icon={call.kind === "subagent" ? Bot : SquareTerminal} label={KIND_LABEL[call.kind]}>
        {call.label ? <NarrativeToolRowDetail kind={call.kind === "command" ? "command" : "prose"}>{call.label}</NarrativeToolRowDetail> : null}
        <NarrativeToolRowMeta>Stopped</NarrativeToolRowMeta>
      </NarrativeToolRow>
    </li>
  );
}

/** A wake after a planned restart, listed as an event row with the background calls the restart stopped. */
function PlannedRestartWakeRow({ text, failed, calls }: { text: string; failed: boolean; calls: readonly StoppedBackgroundCall[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // Stored history must not announce on every mount, so a failure is a note with a spoken prefix, not an alert.
  const label = failed ? <span className="text-destructive"><span className="sr-only">Error: </span>{text}</span> : text;
  const omitted = calls.length - MAX_LISTED_CALLS;
  return (
    <div className="min-w-0 max-w-full py-1" role={failed ? "note" : undefined}>
      <NarrativeToolRow
        icon={failed ? CircleAlert : Zap}
        label={label}
        disclosure={{ open, onToggle: () => setOpen((current) => !current), controlsId: listId }}
      >
        <NarrativeToolRowMeta>{stoppedSummary(calls.length)}</NarrativeToolRowMeta>
      </NarrativeToolRow>
      <AnimatedCollapsible open={open}>
        <ul id={listId} className="mt-1 min-w-0 max-w-full space-y-1 pb-2 pl-6" aria-label="Background tasks stopped by the restart">
          {calls.slice(0, MAX_LISTED_CALLS).map((call) => <StoppedCallRow key={call.id} call={call} />)}
          {omitted > 0 ? <li className="text-xs text-muted">and {omitted} more</li> : null}
        </ul>
      </AnimatedCollapsible>
    </div>
  );
}

/**
 * A planned-restart notice at its own place in the timeline. A wake that stopped background calls shows them as
 * event rows; every other notice is a hairline, in the error tone on failure.
 */
export const PlannedRestartNotice = memo(function PlannedRestartNotice({ message }: { message: Message }) {
  const noticeKey = message.systemNotice?.noticeKey;
  const stoppedCalls = useMemo(() => createPlannedRestartStoppedCallsSelector(noticeKey), [noticeKey]);
  const select = useCallback((record: ThreadRecord) => stoppedCalls(record.canonicalAgent.state), [stoppedCalls]);
  const calls = useThreadRecord(message.thread_id, select);
  const failed = isPlannedRestartFailure(message);
  if (calls.length > 0) return <PlannedRestartWakeRow text={message.content} failed={failed} calls={calls} />;
  return <TimelineNote text={message.content} tone={failed ? "error" : "neutral"} />;
});
