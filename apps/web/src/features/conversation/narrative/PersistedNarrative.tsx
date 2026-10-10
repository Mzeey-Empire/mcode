import { useMemo } from "react";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { SubagentRosterTarget } from "./types";
import { NarrativeRows } from "./NarrativeRows";
import { buildPersistedNarrativeItems } from "./build-persisted-narrative";
import { NarrativePerformanceBoundary } from "./NarrativePerformanceBoundary";

/** Props for `PersistedNarrative`. */
export interface PersistedNarrativeProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id (server-side or local) whose narrative to render. */
  messageId: string;
  /**
   * Body of the assistant message. Used by the client-side suffix-match
   * safety net to suppress thought segments that duplicate the message body.
   */
  messageContent?: string;
  /** Opens one persisted subagent row in the shared detail panel. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/**
 * Render the persisted narrative timeline for a completed assistant message.
 *
 * Receives a visible transcript row's bounded detail window. Returns `null`
 * until that row's request finishes so the layout does not jump.
 *
 * Persisted mode differences from live `NarrativeFlow`:
 *   - No `NarrativeIndicator` (the turn is over)
 *   - Sub-agents render via the same `SubagentRow` but lack the "active"
 *     visual treatment (no pulse, no primary tint)
 */
export function PersistedNarrative({
  threadId,
  messageId,
  messageContent,
  onSubagentSelect,
  onOpenSubagents,
}: PersistedNarrativeProps) {
  const records = useThreadRecord(threadId, (r) => r.narrativeByMessage[messageId]);

  const items = useMemo(
    () => records ? buildPersistedNarrativeItems({ ...records, messageContent }) : [],
    [records, messageContent],
  );

  if (!records) return null;
  if (items.length === 0) return null;

  return (
    <NarrativePerformanceBoundary>
    <div className="relative min-w-0 max-w-full">
      <NarrativeRows
        items={items}
        onSubagentSelect={onSubagentSelect}
        onOpenSubagents={onOpenSubagents}
      />
    </div>
    </NarrativePerformanceBoundary>
  );
}
