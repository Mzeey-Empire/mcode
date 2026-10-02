import type { WsMethodName, SetThreadSubscriptionsInput, CanonicalAgentProgressRecovery } from "@mcode/contracts";
import type { WebSocket } from "ws";
import type { CanonicalAgentBoundary } from "../../features/agents/index.js";
import type { CanonicalAcceptedProgress } from "../../features/agents/canonical/canonical-accepted-progress.js";
import {
  setClientThreadSubscriptions,
  subscribeClientToThread,
  unsubscribeClientFromThread,
} from "./push.js";

type PushSubscriptionMethod =
  | "push.subscribeThread"
  | "push.unsubscribeThread"
  | "push.setThreadSubscriptions";

/** Defines dependencies required to route connection-owned push subscription RPC calls. */
export interface PushSubscriptionRouterDeps {
  canonicalSink: CanonicalAgentBoundary;
  canonicalProgress?: Pick<CanonicalAcceptedProgress, "recover">;
}

const pushSubscriptionHandlers: Record<
  PushSubscriptionMethod,
  (deps: PushSubscriptionRouterDeps, params: any, client: WebSocket | undefined) => unknown
> = {
  "push.subscribeThread": (_deps, params, client) => {
    if (client) subscribeClientToThread(client, params.threadId);
  },
  "push.unsubscribeThread": (_deps, params, client) => {
    if (client) unsubscribeClientFromThread(client, params.threadId);
  },
  "push.setThreadSubscriptions": (deps, params, client) => {
    if (!client) return { canonicalRecoveries: [] };
    setClientThreadSubscriptions(client, params.threadIds);
    const canonicalRecoveries = recoverSubscriptions(deps, params);
    return { canonicalRecoveries };
  },
};

function recoverSubscriptions(deps: PushSubscriptionRouterDeps, params: SetThreadSubscriptionsInput): CanonicalAgentProgressRecovery[] {
  return params.threadIds.map((threadId) => {
    const revision = params.revisions?.[threadId] ?? { conversationRevision: 0, rosterRevision: 0 };
    if (deps.canonicalProgress) return deps.canonicalProgress.recover(threadId, revision, params.progressCursors?.[threadId]);
    return { phase: "recovery", threadId, epoch: `durable:${threadId}`, acceptedThrough: 0, savedThrough: 0,
      durable: deps.canonicalSink.recoverThread(threadId, revision), retained: [], loss: "none" };
  });
}

/** Checks whether a method belongs to the connection-owned push subscription RPC family. */
export function isPushSubscriptionRpcMethod(method: WsMethodName): method is PushSubscriptionMethod {
  return Object.hasOwn(pushSubscriptionHandlers, method);
}

/** Routes validated connection-owned push subscription RPC parameters. */
export function routePushSubscriptionRpc(
  method: WsMethodName,
  params: any,
  deps: PushSubscriptionRouterDeps,
  client: WebSocket | undefined,
): unknown {
  if (!isPushSubscriptionRpcMethod(method)) {
    throw new Error(`Unsupported push subscription method: ${method}`);
  }
  return pushSubscriptionHandlers[method](deps, params, client);
}
