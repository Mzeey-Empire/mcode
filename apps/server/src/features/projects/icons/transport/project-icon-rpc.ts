import { WS_METHODS, type WsMethodName } from "@mcode/contracts/ws/methods";
import type { z } from "zod";
import { broadcast } from "../../../../application/transport/push.js";
import type { ProjectIconService } from "../project-icon-service.js";

type ProjectIconRpcMethod = Extract<WsMethodName, `workspace.icon.${string}`>;

type ProjectIconRpcParamsByMethod = {
  [Method in ProjectIconRpcMethod]: z.output<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Services required to route validated project icon RPC calls. */
export interface ProjectIconRouterDeps {
  projectIconService: Pick<ProjectIconService, "resolve" | "set" | "candidates">;
}

type ProjectIconHandlerMap = {
  [Method in ProjectIconRpcMethod]: (
    deps: ProjectIconRouterDeps,
    params: ProjectIconRpcParamsByMethod[Method],
  ) => Promise<unknown>;
};

const projectIconHandlers: ProjectIconHandlerMap = {
  "workspace.icon.candidates": async (deps, params) => (
    deps.projectIconService.candidates(params.workspaceId, params.query, params.limit)
  ),
  "workspace.icon.resolve": async (deps, params) => ({
    icons: await deps.projectIconService.resolve(params.workspaceIds),
  }),
  "workspace.icon.set": async (deps, params) => {
    const icon = await deps.projectIconService.set(params.workspaceId, params.iconPath);
    broadcast("workspace.iconChanged", { workspaceId: params.workspaceId, icon });
    return icon;
  },
};

/** Checks whether a method belongs to the project icon RPC family. */
export function isProjectIconRpcMethod(method: WsMethodName): method is ProjectIconRpcMethod {
  return Object.hasOwn(projectIconHandlers, method);
}

/** Routes validated project icon RPC parameters to the icon service. */
export async function routeProjectIconRpc<Method extends ProjectIconRpcMethod>(
  method: Method,
  params: ProjectIconRpcParamsByMethod[Method],
  deps: ProjectIconRouterDeps,
): Promise<unknown> {
  return await projectIconHandlers[method](deps, params);
}
