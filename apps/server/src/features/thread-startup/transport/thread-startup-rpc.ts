import type {
  ThreadStartupCancelInput,
  ThreadStartupGetInput,
  ThreadStartupListInput,
  WsMethodName,
} from "@mcode/contracts";
import type { AgentService } from "../../agents/orchestration/agent-service.js";
import type { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import type { ThreadStartupService } from "../thread-startup-service.js";

type ThreadStartupRpcMethod =
  | "thread.startup.get"
  | "thread.startup.list"
  | "thread.startup.cancel";

type ThreadStartupParamsByMethod = {
  "thread.startup.get": ThreadStartupGetInput;
  "thread.startup.list": ThreadStartupListInput;
  "thread.startup.cancel": ThreadStartupCancelInput;
};

/** Dependencies required to route thread startup lifecycle RPC calls. */
export interface ThreadStartupRouterDeps {
  threadStartupService: Pick<ThreadStartupService, "get" | "list" | "cancel" | "markCancelled">;
  workspaceEnvironmentService: Pick<WorkspaceEnvironmentService, "stopAutomaticSetup">;
  agentService: Pick<AgentService, "stopSession">;
}

type ThreadStartupHandlerMap = {
  [Method in ThreadStartupRpcMethod]: (
    deps: ThreadStartupRouterDeps,
    params: ThreadStartupParamsByMethod[Method],
  ) => unknown;
};

const threadStartupHandlers: ThreadStartupHandlerMap = {
  "thread.startup.get": (deps, params) => deps.threadStartupService.get(params.startupId),
  "thread.startup.list": (deps, params) => ({ records: deps.threadStartupService.list(params.workspaceId) }),
  "thread.startup.cancel": async (deps, params) => {
    const startup = await deps.threadStartupService.cancel(params.startupId);
    if (
      !startup.threadId
      || ["completed", "failed", "cancelled", "interrupted"].includes(startup.state)
    ) return startup;

    switch (startup.phase) {
      case "setup":
        await deps.workspaceEnvironmentService.stopAutomaticSetup({ threadId: startup.threadId });
        return deps.threadStartupService.markCancelled(startup.startupId);
      case "agent":
        // Intent is committed before the stop, so a first provider frame racing it settles as cancelled,
        // and a turn stopped before dispatch commits no turn fact for the observer. Once the stop
        // resolves, the record is either already terminal (markCancelled keeps it) or cancelled.
        await deps.agentService.stopSession(startup.threadId);
        return deps.threadStartupService.markCancelled(startup.startupId);
      case "thread":
      case "fetch":
      case "worktree":
        return startup;
    }
  },
};

/** Checks whether a method belongs to the thread startup lifecycle RPC family. */
export function isThreadStartupRpcMethod(method: WsMethodName): method is ThreadStartupRpcMethod {
  return Object.hasOwn(threadStartupHandlers, method);
}

/** Routes validated thread startup lifecycle RPC parameters. */
export function routeThreadStartupRpc<Method extends ThreadStartupRpcMethod>(
  method: Method,
  params: ThreadStartupParamsByMethod[Method],
  deps: ThreadStartupRouterDeps,
): unknown {
  return threadStartupHandlers[method](deps, params);
}
