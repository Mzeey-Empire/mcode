import { foldDescendants, type ThreadDescendants } from "@mcode/contracts/models/thread-attention";
import type { SubagentRosterService } from "../../agents/collaboration/subagent-roster-service.js";
import type { AgentWorkload } from "../../agents/workload/agent-workload.js";

/** Live descendants and the parents worth checking when hydrating attention. */
export interface ThreadDescendantsSource {
  descendants(threadId: string): ThreadDescendants;
  candidates(): ReadonlySet<string>;
}

/** Fold roster statuses together with background launches still awaiting their first save. */
export function threadDescendantsSource(
  roster: Pick<SubagentRosterService, "loadLiveStatuses" | "liveParentCandidates">,
  workload: Pick<AgentWorkload, "backgroundSubagentThreadIds">,
): ThreadDescendantsSource {
  return {
    descendants: (threadId) => {
      const statuses = roster.loadLiveStatuses(threadId);
      if (workload.backgroundSubagentThreadIds().has(threadId)) statuses.push("running");
      return foldDescendants(statuses);
    },
    candidates: () => roster.liveParentCandidates(workload.backgroundSubagentThreadIds()),
  };
}
