import type { WsMethodName } from "@mcode/contracts/ws/methods";
import type {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
} from "../index.js";

type ThreadControlMethod =
  | "threadControl.pairing.create"
  | "threadControl.pairing.revoke"
  | "threadControl.pairing.replace";

/** Defines the services required to route validated Thread Control RPC calls. */
export interface ThreadControlRouterDeps {
  externalThreadControlPairingService?: ExternalThreadControlPairingService;
  externalThreadControlMcpRuntime?: ExternalThreadControlMcpRuntime;
}

const threadControlHandlers: Record<
  ThreadControlMethod,
  (deps: ThreadControlRouterDeps, params: any) => Promise<unknown> | unknown
> = {
  "threadControl.pairing.create": async (deps, params) => {
    const pairings = requirePairings(deps);
    const pairing = await pairings.create(params);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
    };
  },
  "threadControl.pairing.revoke": async (deps, params) => {
    const pairings = requirePairings(deps);
    const pairing = await pairings.revoke(params.pairingId);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? "/mcp/external-thread-control",
    };
  },
  "threadControl.pairing.replace": async (deps, params) => {
    const pairings = requirePairings(deps);
    const { pairingId, ...input } = params;
    const pairing = await pairings.replace(pairingId, input);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
    };
  },
};

/** Checks whether a method belongs to the Thread Control RPC family. */
export function isThreadControlRpcMethod(method: WsMethodName): method is ThreadControlMethod {
  return Object.hasOwn(threadControlHandlers, method);
}

/** Routes validated Thread Control RPC parameters. */
export async function routeThreadControlRpc(
  method: WsMethodName,
  params: any,
  deps: ThreadControlRouterDeps,
): Promise<unknown> {
  if (!isThreadControlRpcMethod(method)) {
    throw new Error(`Unsupported Thread Control method: ${method}`);
  }
  return await threadControlHandlers[method](deps, params);
}

function requirePairings(deps: ThreadControlRouterDeps): ExternalThreadControlPairingService {
  if (!deps.externalThreadControlPairingService) {
    throw new Error("External thread-control pairing service unavailable");
  }
  return deps.externalThreadControlPairingService;
}
