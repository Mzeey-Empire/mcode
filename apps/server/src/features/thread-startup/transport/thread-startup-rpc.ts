import type {
  ThreadStartupCancelInput,
  ThreadStartupGetInput,
  ThreadStartupListInput,
  ThreadStartupResolveInput,
  ThreadStartupRetryAgentInput,
  WsMethodName,
} from "@mcode/contracts";
import type { AgentService } from "../../agents/orchestration/agent-service.js";
import type { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import type { ThreadStartupService } from "../thread-startup-service.js";
import type { ThreadStartupFetchDecisions } from "../thread-startup-fetch-decisions.js";
import { cancelThreadStartup } from "../cancel-thread-startup.js";

type ThreadStartupRpcMethod =
  | "thread.startup.get"
  | "thread.startup.list"
  | "thread.startup.resolve"
  | "thread.startup.cancel"
  | "thread.startup.retryAgent";

type ThreadStartupParamsByMethod = {
  "thread.startup.get": ThreadStartupGetInput;
  "thread.startup.list": ThreadStartupListInput;
  "thread.startup.resolve": ThreadStartupResolveInput;
  "thread.startup.cancel": ThreadStartupCancelInput;
  "thread.startup.retryAgent": ThreadStartupRetryAgentInput;
};

/** Dependencies required to route thread startup lifecycle RPC calls. */
export interface ThreadStartupRouterDeps {
  threadStartupFetchDecisions: ThreadStartupFetchDecisions;
  threadStartupService: Pick<ThreadStartupService, "get" | "list" | "cancel" | "markCancelled">;
  workspaceEnvironmentService: Pick<WorkspaceEnvironmentService, "retryAutomaticAgentStart" | "stopAutomaticSetup">;
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
  "thread.startup.resolve": (deps, params) => deps.threadStartupFetchDecisions.resolve(
    deps.threadStartupService.get(params.startupId), params.action,
  ),
  "thread.startup.cancel": (deps, params) => cancelThreadStartup(deps, params.startupId),
  "thread.startup.retryAgent": async (deps, params) => {
    const startup = deps.threadStartupService.get(params.startupId);
    if (!startup?.threadId) throw new Error("This startup has no thread to retry");
    await deps.workspaceEnvironmentService.retryAutomaticAgentStart({ threadId: startup.threadId });
    return deps.threadStartupService.get(params.startupId);
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
