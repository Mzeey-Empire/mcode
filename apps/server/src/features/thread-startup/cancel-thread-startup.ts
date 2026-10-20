import type { ThreadStartup } from "@mcode/contracts";
import type { AgentService } from "../agents/orchestration/agent-service.js";
import type { WorkspaceEnvironmentService } from "../projects/environment/workspace-environment-service.js";
import type { ThreadStartupService } from "./thread-startup-service.js";
import type { ThreadStartupFetchDecisions } from "./thread-startup-fetch-decisions.js";

/** Existing lifecycle owners needed to record cancellation and contain startup work. */
export interface CancelThreadStartupDeps {
  threadStartupService: Pick<ThreadStartupService, "cancel" | "markCancelled">;
  threadStartupFetchDecisions: Pick<ThreadStartupFetchDecisions, "cancel">;
  workspaceEnvironmentService: Pick<WorkspaceEnvironmentService, "stopAutomaticSetup">;
  agentService: Pick<AgentService, "stopSession">;
}

/** Commit intent before stopping setup or the first provider dispatch. */
export async function cancelThreadStartup(deps: CancelThreadStartupDeps, startupId: string): Promise<ThreadStartup> {
  const startup = await deps.threadStartupService.cancel(startupId);
  if (startup.phase === "fetch") deps.threadStartupFetchDecisions.cancel(startup.startupId);
  if (!startup.threadId || ["completed", "failed", "cancelled", "interrupted"].includes(startup.state)) return startup;
  switch (startup.phase) {
    case "setup":
      await deps.workspaceEnvironmentService.stopAutomaticSetup({ threadId: startup.threadId });
      return deps.threadStartupService.markCancelled(startup.startupId);
    case "agent":
      await deps.agentService.stopSession(startup.threadId, { by: "user" });
      return deps.threadStartupService.markCancelled(startup.startupId);
    case "thread":
    case "fetch":
    case "worktree":
      return startup;
  }
}
