import { foldDescendants, type ThreadDescendants } from "@mcode/contracts/models/thread-attention";
import type { SubagentRosterService } from "../../agents/collaboration/subagent-roster-service.js";
import type { AgentWorkload } from "../../agents/workload/agent-workload.js";
import type { BackgroundCommandStore } from "../../agents/background/background-command-store.js";

/** Live descendants and the parents worth checking when hydrating attention. */
export interface ThreadDescendantsSource {
  descendants(threadId: string): ThreadDescendants;
  candidates(): ReadonlySet<string>;
}

/** Combine child statuses and background work that holds the parent's completion. */
export function threadDescendantsSource(
  roster: Pick<SubagentRosterService, "loadLiveStatuses" | "liveParentCandidates">,
  workload: Pick<AgentWorkload, "backgroundSubagentThreadIds">,
  commands: Pick<BackgroundCommandStore, "hasAwaitedRunning" | "threadsWithAwaitedRunning">,
): ThreadDescendantsSource {
  return {
    descendants: (threadId) => {
      const statuses = roster.loadLiveStatuses(threadId);
      if (workload.backgroundSubagentThreadIds().has(threadId)) statuses.push("running");
      if (commands.hasAwaitedRunning(threadId)) statuses.push("running");
      return foldDescendants(statuses);
    },
    candidates: () => new Set([
      ...roster.liveParentCandidates(workload.backgroundSubagentThreadIds()),
      ...commands.threadsWithAwaitedRunning(),
    ]),
  };
}
