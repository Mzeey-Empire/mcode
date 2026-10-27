import { resolveBuildStage, type BuildStage } from "@mcode/contracts/build-stage";
import { type WsMethodName } from "@mcode/contracts/ws/methods";

type ApplicationRpcMethod = "app.version" | "app.stage";

const applicationHandlers = {
  "app.version": () => process.env.MCODE_VERSION ?? "0.0.1",
  "app.stage": () => resolveServerBuildStage(),
} satisfies Record<ApplicationRpcMethod, () => string>;

/** Build stage of this server process, from the dev launcher marker and its version. */
export function resolveServerBuildStage(): BuildStage {
  return resolveBuildStage({
    agentRuntime: process.env.MCODE_AGENT_RUNTIME === "1",
    version: process.env.MCODE_VERSION ?? "",
  });
}

/** Checks whether a method belongs to the application-owned RPC family. */
export function isApplicationRpcMethod(method: WsMethodName): method is ApplicationRpcMethod {
  return Object.hasOwn(applicationHandlers, method);
}

/** Routes validated application-owned RPC parameters. */
export function routeApplicationRpc(method: ApplicationRpcMethod): string {
  return applicationHandlers[method]();
}
